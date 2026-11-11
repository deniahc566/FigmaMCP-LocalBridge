import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { nodeToXml, pagesToXml } from '../codegen/metadata.js';
import { collectImageFills, collectSvgNodes, collectVariableIds, isVisible } from '../codegen/nodes.js';
import { describeEffect, describePaint, visiblePaints } from '../codegen/paint.js';
import { generateReact, renderModule, type VariableInfo } from '../codegen/react.js';
import type { ComponentMeta, FigmaNode, StyleMeta } from '../figma/types.js';
import { errorMessage, mapLimit, num } from '../util.js';
import {
  clientFrameworksParam,
  clientLanguagesParam,
  fileKeyParam,
  guarded,
  image,
  json,
  location,
  nodeIdParam,
  renderedBase64,
  sniffFormat,
  target,
  text,
  toolName,
  type ToolBase,
  type ToolDeps,
} from './common.js';

const MAX_CODE_NODES = 2500;
const LARGE_CODE_CHARS = 120_000;
const LARGE_CODE_NODES = 1500;

function curlHint(url: string, file: string): string {
  return `curl -L -o ${file} "${url}"`;
}

/** Styles applied anywhere in the subtree: style name -> human-readable value. */
function collectStyles(root: FigmaNode, styles: Record<string, StyleMeta>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (n: FigmaNode) => {
    if (!isVisible(n)) return;
    for (const [kind, styleId] of Object.entries(n.styles ?? {})) {
      const meta = styles[styleId];
      if (!meta || out[meta.name]) continue;
      out[meta.name] = describeStyle(kind, n);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

function describeStyle(kind: string, n: FigmaNode): string {
  switch (kind) {
    case 'fill':
    case 'fills': {
      const paints = visiblePaints(n.fills);
      return paints.length ? paints.map(describePaint).join(', ') : 'none';
    }
    case 'stroke':
    case 'strokes': {
      const paints = visiblePaints(n.strokes);
      return paints.length ? paints.map(describePaint).join(', ') : 'none';
    }
    case 'text': {
      const s = n.style ?? {};
      const lineHeight =
        s.lineHeightUnit === 'INTRINSIC_%' ? 'auto' : s.lineHeightUnit === 'FONT_SIZE_%' ? `${num(s.lineHeightPercentFontSize ?? 100)}%` : num(s.lineHeightPx ?? 0);
      return `Font(family: "${s.fontFamily}", style: ${s.fontStyle ?? 'Regular'}, size: ${num(s.fontSize ?? 0)}, weight: ${s.fontWeight ?? 400}, lineHeight: ${lineHeight}, letterSpacing: ${num(s.letterSpacing ?? 0)})`;
    }
    case 'effect':
    case 'effects':
      return (n.effects ?? []).filter((e) => e.visible !== false).map(describeEffect).join(', ') || 'none';
    case 'grid':
      return 'LayoutGrid';
    default:
      return kind;
  }
}

async function variableMap(deps: ToolDeps, fileKey: string, root: FigmaNode) {
  const ids = [...collectVariableIds(root)];
  const outcome = await deps.variables.resolve(fileKey, ids, root.id);
  const map = new Map<string, VariableInfo>();
  for (const [id, v] of outcome.variables) map.set(id, { name: v.name, value: v.value, webSyntax: v.webSyntax });
  return { ids, outcome, map };
}

type CodeLink = { codeConnectSrc: string; codeConnectName: string; component?: string };

/**
 * Code links for the component instances in a subtree, read from Dev Mode dev resources on each
 * main component (or its component set), following library components to their source file.
 */
async function codeLinks(
  deps: ToolDeps,
  fileKey: string,
  root: FigmaNode,
  components: Record<string, ComponentMeta>,
  componentSets: Record<string, ComponentMeta>,
  label?: string,
): Promise<Record<string, CodeLink>> {
  const usages: { nodeId: string; componentId: string; meta?: ComponentMeta }[] = [];
  const walk = (n: FigmaNode) => {
    if (!isVisible(n)) return;
    if (n.type === 'INSTANCE' && n.componentId) usages.push({ nodeId: n.id, componentId: n.componentId, meta: components[n.componentId] });
    else if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') usages.push({ nodeId: n.id, componentId: n.id, meta: components[n.id] ?? componentSets[n.id] });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  if (!usages.length) return {};

  type Loc = { fileKey: string; nodeId: string };
  const locs = new Map<string, Loc[]>();
  const unique = [...new Map(usages.map((u) => [u.componentId, u])).values()].slice(0, 40);
  await mapLimit(unique, 6, async (u) => {
    const out: Loc[] = [];
    if (!u.meta?.remote) {
      out.push({ fileKey, nodeId: u.componentId });
      if (u.meta?.componentSetId) out.push({ fileKey, nodeId: u.meta.componentSetId });
    } else {
      try {
        const pub = await deps.rest.getPublishedAsset('components', u.meta.key);
        out.push({ fileKey: pub.file_key, nodeId: pub.node_id });
        const set = u.meta.componentSetId ? componentSets[u.meta.componentSetId] : undefined;
        if (set?.key) {
          const pubSet = await deps.rest.getPublishedAsset('component_sets', set.key);
          out.push({ fileKey: pubSet.file_key, nodeId: pubSet.node_id });
        }
      } catch {
        // Unpublished or inaccessible library component: no dev resources to read.
      }
    }
    locs.set(u.componentId, out);
  });

  const byFile = new Map<string, Set<string>>();
  for (const list of locs.values()) {
    for (const l of list) {
      if (!byFile.has(l.fileKey)) byFile.set(l.fileKey, new Set());
      byFile.get(l.fileKey)!.add(l.nodeId);
    }
  }
  const resources = new Map<string, { name: string; url: string }[]>();
  await mapLimit([...byFile], 4, async ([key, ids]) => {
    try {
      for (const r of await deps.rest.getDevResources(key, [...ids])) {
        const k = `${key}:${r.node_id}`;
        if (!resources.has(k)) resources.set(k, []);
        resources.get(k)!.push({ name: r.name, url: r.url });
      }
    } catch {
      // No Dev Mode access to that file.
    }
  });

  const wanted = label?.toLowerCase();
  const map: Record<string, CodeLink> = {};
  for (const u of usages) {
    const links = (locs.get(u.componentId) ?? []).flatMap((l) => resources.get(`${l.fileKey}:${l.nodeId}`) ?? []);
    const pick = links.find((l) => !wanted || l.name.toLowerCase().includes(wanted) || l.url.toLowerCase().includes(wanted));
    if (pick) map[u.nodeId] = { codeConnectSrc: pick.url, codeConnectName: pick.name || u.meta?.name || '', component: u.meta?.name };
  }
  return map;
}

export function registerDesignTools(server: McpServer, deps: ToolDeps) {
  const n = (base: ToolBase) => toolName(deps.config.toolPrefix, base);

  server.registerTool(
    n('get_design_context'),
    {
      title: 'Get design context',
      description:
        'Get design context for a Figma node — the primary tool for design-to-code workflows. Returns React + Tailwind reference code, asset download URLs, the design tokens and components used, and a screenshot of the node. The code is a reference: adapt it to the target project\'s components, design tokens and conventions. Use the nodeId parameter to specify a node id and the fileKey parameter to specify the file key. If given the URL https://figma.com/design/:fileKey/:fileName?node-id=1-2, the nodeId is `1:2` and the fileKey is `:fileKey`. If the URL does not include `node-id`, ask the user for a node-specific URL; do not pass an empty or guessed nodeId. For branch URLs (https://figma.com/design/:fileKey/branch/:branchKey/:fileName) use the branchKey as the fileKey.',
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam,
        clientLanguages: clientLanguagesParam,
        clientFrameworks: clientFrameworksParam,
        excludeScreenshot: z
          .boolean()
          .optional()
          .describe('Whether to exclude the screenshot of the design from the response. Not recommended; only set when the user asks or to preserve context.'),
        forceCode: z
          .boolean()
          .optional()
          .describe('Whether code should always be returned, instead of just metadata when the output is too large. Only set when the user directly asks.'),
        disableCodeConnect: z.boolean().optional().describe('Whether to skip Code Connect (dev resource) lookups. Only set when the user asks.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey, args.nodeId);
      const nodeId = t.nodeId!;
      const read = await deps.reader.getNode(t.fileKey, nodeId);
      const { document: root, components, componentSets, styles, file } = read;
      const vars = await variableMap(deps, t.fileKey, root);

      const result = generateReact(root, { components, componentSets, styles, variables: vars.map, maxNodes: MAX_CODE_NODES });
      const tooLarge = result.nodeCount > LARGE_CODE_NODES || result.jsx.length > LARGE_CODE_CHARS;
      if (tooLarge && !args.forceCode) {
        const { xml } = nodeToXml(root);
        return {
          content: [
            text(
              `The design is too large to return as code (${result.nodeCount} layers). Here is its structure instead. Call ${n('get_design_context')} on the child node IDs below for code, or pass forceCode: true.`,
            ),
            text(xml),
          ],
        };
      }

      // Resolve assets: SVG renders for vector layers, original files for image fills. Plugin reads
      // give local file paths, REST reads give temporary URLs.
      const urls: Record<string, string | null> = {};
      const svgAssets = result.assets.filter((a) => a.kind === 'svg');
      const imageAssets = result.assets.filter((a) => a.kind === 'image');
      const refs = [...new Set(imageAssets.map((a) => a.imageRef).filter((r): r is string => Boolean(r)))];
      const [svgs, fills] = await Promise.all([
        deps.reader.svgs(t.fileKey, svgAssets.map((a) => ({ id: a.nodeId, name: a.varName }))),
        deps.reader.imageFills(t.fileKey, refs),
      ]);
      for (const a of svgAssets) urls[a.varName] = svgs[a.nodeId]?.file ?? svgs[a.nodeId]?.url ?? null;
      for (const a of imageAssets) {
        const r = a.imageRef ? fills[a.imageRef] : undefined;
        urls[a.varName] = r?.file ?? r?.url ?? null;
      }

      const code = renderModule(result, urls);
      const tokens: Record<string, string> = {};
      for (const v of vars.outcome.variables.values()) tokens[v.name] = v.value;
      const styleTokens = collectStyles(root, styles);

      const frameworks = (args.clientFrameworks ?? '').toLowerCase();
      const nonReact = frameworks && !frameworks.includes('react') && !frameworks.includes('unknown') && !frameworks.includes('next');
      const notes: string[] = [
        'This is React + Tailwind reference code generated from the Figma layer tree. It is not production code: convert it to the target project\'s framework, styling system, components and tokens.',
        nonReact ? `The client reports ${args.clientFrameworks}; translate the structure and styles rather than copying JSX.` : '',
        'Reuse existing project components for the component instances listed below instead of re-implementing their internals.',
        'Prefer the project\'s design tokens over raw values; `var(--token,fallback)` marks values bound to Figma variables.',
        read.source === 'plugin'
          ? 'Read through the Figma MCP Bridge plugin, so no REST API quota was used.' +
            (Object.keys(urls).length ? ' Assets were rendered locally; copy the files into the project.' : '')
          : Object.keys(urls).length
            ? 'Asset URLs are temporary (they expire). Download them into the project instead of hot-linking.'
            : '',
        result.truncated ? `Output was truncated after ${MAX_CODE_NODES} layers.` : '',
        vars.outcome.note && vars.ids.length ? vars.outcome.note : '',
      ].filter(Boolean);

      let links: Record<string, CodeLink> = {};
      if (!args.disableCodeConnect && result.instances.length) {
        try {
          links = await codeLinks(deps, t.fileKey, root, components, componentSets);
        } catch {
          // Code links are a bonus; never fail design context over them.
        }
      }
      const instances = result.instances.map((i) => ({
        nodeId: i.nodeId,
        layer: i.name,
        component: i.componentSetName ? `${i.componentSetName} / ${i.componentName}` : i.componentName,
        properties: i.properties,
        fromLibrary: i.remote || undefined,
        codeConnect: links[i.nodeId],
      }));
      if (Object.keys(links).length) notes.push('Instances with codeConnect point to existing code components: import and use those instead of the generated markup.');

      const context: Record<string, unknown> = {
        node: { id: root.id, name: root.name, type: root.type },
        file: { name: file.name, lastModified: file.lastModified },
        source: read.source,
      };
      if (instances.length) context.componentInstances = instances;
      if (Object.keys(tokens).length) context.variables = tokens;
      if (vars.outcome.unresolved.length) context.unresolvedVariableIds = vars.outcome.unresolved;
      if (Object.keys(styleTokens).length) context.styles = styleTokens;
      if (result.assets.length) {
        context.assets = Object.fromEntries(result.assets.map((a) => [a.varName, { nodeId: a.nodeId, kind: a.kind, url: urls[a.varName] }]));
      }

      const content: CallToolResult['content'] = [
        text(code),
        text(`${notes.map((n) => `- ${n}`).join('\n')}\n\n${JSON.stringify(context, null, 2)}`),
      ];

      if (!args.excludeScreenshot) {
        try {
          const shot = await deps.reader.screenshot(t.fileKey, nodeId, { node: root });
          content.push(image(await renderedBase64(deps, shot)));
        } catch (err) {
          content.push(text(`(Screenshot unavailable: ${errorMessage(err)})`));
        }
      }
      return { content };
    }),
  );

  server.registerTool(
    n('get_metadata'),
    {
      title: 'Get metadata',
      description:
        `IMPORTANT: Always prefer ${n('get_design_context')}. Get metadata for a node or page in XML format: node IDs, layer types, names, positions and sizes only. Useful for an overview of the structure; call ${n('get_design_context')} on the node IDs it contains.` +
        ' The nodeId can also be a page id (e.g. 0:1). When nodeId is omitted, returns the top-level pages of the document instead. If the URL includes `node-id`, pass it as nodeId; otherwise omit nodeId. For branch URLs use the branchKey as the fileKey.',
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam.optional(),
        clientLanguages: clientLanguagesParam,
        clientFrameworks: clientFrameworksParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey, args.nodeId);
      const selection = deps.bridge?.hasFile(t.fileKey) ? deps.bridge.list().find((p) => !p.fileKey || p.fileKey === t.fileKey)?.selection ?? [] : [];
      const prefix = selection.length ? `Currently selected nodes:\n${selection.map((s) => `- ${s.id} ${s.name} (${s.type})`).join('\n')}\n\n` : '';
      if (!t.nodeId) {
        const pages = await deps.reader.getPages(t.fileKey);
        return { content: [text(prefix + pagesToXml(pages.name, pages.document))] };
      }
      const { document } = await deps.reader.getNode(t.fileKey, t.nodeId);
      const { xml, truncated } = nodeToXml(document);
      return { content: [text(prefix + xml + (truncated ? '\n(Truncated. Query a child node for the rest.)' : ''))] };
    }),
  );

  server.registerTool(
    n('get_screenshot'),
    {
      title: 'Get screenshot',
      description:
        "Generate a screenshot for a node. Works on design files, FigJam boards and Slides. maxDimension (default 1024) caps the longer edge of the PNG; the metadata includes the rendered width/height and the node's original_width/original_height. By default returns a short-lived URL plus curl instructions, or a local file path when the companion plugin rendered it; both cost far fewer tokens than an inline image. Set enableBase64Response: true only when you cannot fetch URLs or read files. nodeId and fileKey are required; extract them from the URL (node-id=1-2 -> 1:2). For branch URLs use the branchKey as the fileKey.",
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam,
        maxDimension: z.number().int().positive().max(65536).optional().describe('Maximum pixel size of the longer edge. Defaults to 1024.'),
        contentsOnly: z
          .boolean()
          .optional()
          .describe(
            'When true, renders the node in isolation, excluding overlapping content. Defaults to false so the screenshot matches the canvas.',
          ),
        enableBase64Response: z.boolean().optional().describe('When true, also include the screenshot inline as base64. Defaults to false.'),
        clientLanguages: clientLanguagesParam,
        clientFrameworks: clientFrameworksParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey, args.nodeId);
      const shot = await deps.reader.screenshot(t.fileKey, t.nodeId!, { maxDimension: args.maxDimension, contentsOnly: args.contentsOnly });
      const { data: _bytes, ...meta } = shot;
      const content: CallToolResult['content'] = [json({ ...meta, format: 'png' })];
      if (shot.url) {
        content.push(text(`Download the screenshot (the URL expires):\n${curlHint(shot.url, `figma-${t.nodeId!.replace(/[^\w]/g, '-')}.png`)}`));
      } else {
        content.push(text(`Rendered by the Figma plugin and saved to ${shot.file}`));
      }
      if (args.enableBase64Response) content.push(image(await renderedBase64(deps, shot)));
      return { content };
    }),
  );

  server.registerTool(
    n('get_variable_defs'),
    {
      title: 'Get variable definitions',
      description:
        "Get the variables and styles used by a node and its children, e.g. {'icon/default/secondary': '#949494'}. Variables are reusable values for colors, sizes, spacing and fonts. Extract nodeId from the URL (node-id=1-2 -> 1:2); do not pass an empty or guessed nodeId. Variable names resolve through the companion plugin when it is running in the file, or through the REST variables API on Enterprise plans. For branch URLs use the branchKey as the fileKey.",
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam,
        clientLanguages: clientLanguagesParam,
        clientFrameworks: clientFrameworksParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey, args.nodeId);
      const { document: root, styles } = await deps.reader.getNode(t.fileKey, t.nodeId!);
      const { outcome } = await variableMap(deps, t.fileKey, root);
      const defs: Record<string, string> = {};
      for (const v of outcome.variables.values()) defs[v.name] = v.value;
      Object.assign(defs, collectStyles(root, styles));
      const content: CallToolResult['content'] = [json(defs)];
      if (outcome.unresolved.length) {
        content.push(text(`${outcome.unresolved.length} bound variable(s) could not be named: ${outcome.unresolved.join(', ')}. ${outcome.note ?? ''}`.trim()));
      }
      return { content };
    }),
  );

  server.registerTool(
    n('get_figjam'),
    {
      title: 'Get FigJam',
      description:
        'Get the content of a FigJam board node as XML: stickies, shapes, connectors (with from/to node IDs), sections, text and tables, including their text and colors. If no node id is provided, use `0:1`. Extract nodeId and fileKey from the URL, e.g. https://figma.com/board/:fileKey/:fileName?node-id=1-2. Only for FigJam files (URL path `/board/`).',
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam,
        includeImagesOfNodes: z.boolean().optional().describe('Whether to include an image of the node in the response. Defaults to true.'),
        clientLanguages: clientLanguagesParam,
        clientFrameworks: clientFrameworksParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey, args.nodeId);
      const { document, file } = await deps.reader.getNode(t.fileKey, t.nodeId!);
      if (file.editorType && file.editorType !== 'figjam') {
        return { content: [text(`File ${t.fileKey} is a ${file.editorType} file, not a FigJam board. Use ${n('get_design_context')} or ${n('get_metadata')} instead.`)], isError: true };
      }
      const { xml } = nodeToXml(document, { rich: true });
      const content: CallToolResult['content'] = [text(xml)];
      if (args.includeImagesOfNodes !== false) {
        try {
          const shot = await deps.reader.screenshot(t.fileKey, t.nodeId!, { node: document });
          content.push(image(await renderedBase64(deps, shot)));
        } catch (err) {
          content.push(text(`(Image unavailable: ${errorMessage(err)})`));
        }
      }
      return { content };
    }),
  );

  server.registerTool(
    n('download_assets'),
    {
      title: 'Download assets',
      description:
        "Download assets for a single node: `export` (an exported image of the whole node), `rawImages` (original uploaded images used as fills in the subtree, capped at 20, each with its real `format`) and `svgAssets` (SVGs for vector layers such as icons and logos, capped at 20). When defaultFormat/defaultScale are given they override the export settings configured on the node; otherwise the node's export settings are used if present, else png at scale 1. Pass them only when the user asks for a specific format or size. Each asset has a temporary `url` (download promptly) or, when the companion plugin rendered it, a local `file` path.",
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam,
        defaultFormat: z.enum(['png', 'jpg', 'svg', 'pdf']).optional().describe('Export format. Overrides the node\'s export settings.'),
        defaultScale: z.number().min(0.01).max(4).optional().describe('Export scale (resolution multiplier). Overrides the node\'s export settings.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey, args.nodeId);
      const nodeId = t.nodeId!;
      const { document: root, source } = await deps.reader.getNode(t.fileKey, nodeId);

      const setting = root.exportSettings?.[0];
      const format = args.defaultFormat ?? ((setting?.format.toLowerCase() as 'png' | 'jpg' | 'svg' | 'pdf' | undefined) ?? 'png');
      let scale = args.defaultScale;
      if (scale === undefined && !args.defaultFormat && setting) {
        const box = root.absoluteBoundingBox;
        if (setting.constraint.type === 'SCALE') scale = setting.constraint.value;
        else if (box && setting.constraint.type === 'WIDTH') scale = setting.constraint.value / box.width;
        else if (box && setting.constraint.type === 'HEIGHT') scale = setting.constraint.value / box.height;
      }
      scale = Math.min(4, Math.max(0.01, scale ?? 1));

      const imageRefs = collectImageFills(root, 20);
      const svgNodes = collectSvgNodes(root, 20).filter((n) => n.id !== nodeId || format !== 'svg');

      const [exported, fills, svgs] = await Promise.all([
        deps.reader.exportNode(t.fileKey, nodeId, format, scale),
        deps.reader.imageFills(t.fileKey, imageRefs.map((r) => r.imageRef)),
        deps.reader.svgs(t.fileKey, svgNodes.map((n) => ({ id: n.id, name: n.name }))),
      ]);

      const rawImages = await mapLimit(imageRefs, 5, async (ref) => {
        const rendered = fills[ref.imageRef];
        let fmt = 'original';
        if (rendered?.data) fmt = sniffFormat(rendered.data);
        else if (rendered?.url) {
          try {
            fmt = sniffFormat((await deps.rest.fetchBinary(rendered.url, 'bytes=0-255')).data);
          } catch {
            // Keep "original" when the probe fails.
          }
        }
        return { nodeId: ref.nodeId, nodeName: ref.nodeName, imageRef: ref.imageRef, ...location(rendered), format: fmt };
      });

      return {
        content: [
          json({
            export: { nodeId, nodeName: root.name, format, scale: format === 'svg' || format === 'pdf' ? undefined : scale, ...location(exported) },
            rawImages,
            svgAssets: svgNodes.map((n) => ({ nodeId: n.id, nodeName: n.name, ...location(svgs[n.id]), format: 'svg' })),
            source,
            note:
              source === 'plugin'
                ? 'Rendered by the Figma plugin and saved as local files; copy them into the project.'
                : 'URLs are temporary. Download them now, e.g. curl -L -o <file> "<url>".',
          }),
        ],
      };
    }),
  );

  server.registerTool(
    n('get_code_connect_map'),
    {
      title: 'Get Code Connect map',
      description:
        "Get a mapping of {[nodeId]: {codeConnectSrc, codeConnectName}} for the component instances in a node, e.g. {'1:2': {codeConnectSrc: 'https://github.com/foo/components/Button.tsx', codeConnectName: 'Button'}}. This server reads the code links attached to components as Dev Mode dev resources (Figma's public API does not expose CLI-published Code Connect files). Extract nodeId and fileKey from the URL; do not pass an empty or guessed nodeId.",
      inputSchema: {
        fileKey: fileKeyParam,
        nodeId: nodeIdParam,
        codeConnectLabel: z.string().optional().describe('Only return links whose name or URL contains this label, e.g. a framework name.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey, args.nodeId);
      const { document: root, components, componentSets } = await deps.reader.getNode(t.fileKey, t.nodeId!);
      const map = await codeLinks(deps, t.fileKey, root, components, componentSets, args.codeConnectLabel);
      const content: CallToolResult['content'] = [json(map)];
      if (!Object.keys(map).length) {
        content.push(text('No code links found. Attach links to the main components in Dev Mode (Dev resources) to populate this map.'));
      }
      return { content };
    }),
  );
}
