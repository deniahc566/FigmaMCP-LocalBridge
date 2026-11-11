import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginBridge } from '../bridge/server.js';
import { errorMessage, sniffFormat } from '../util.js';
import { FigmaApiError, type FigmaRestClient } from './rest.js';
import type { ComponentMeta, FigmaNode, StyleMeta } from './types.js';

/**
 * Reads design data plugin-first: when the companion plugin is open in the requested file, nodes,
 * renders and image fills come from the Plugin API (no REST quota); otherwise from the REST API.
 *
 * The plugin path uses exportAsync({format: 'JSON_REST_V1'}), which yields the same JSON as the REST
 * nodes endpoint, so everything downstream (codegen, XML, variables) is shared. Renders come back as
 * bytes and are saved under assetDir, so plugin reads return file paths where REST returns URLs.
 */

export type ReadSource = 'plugin' | 'rest';

export interface NodeRead {
  document: FigmaNode;
  components: Record<string, ComponentMeta>;
  componentSets: Record<string, ComponentMeta>;
  styles: Record<string, StyleMeta>;
  file: { name: string; lastModified?: string; editorType?: string };
  source: ReadSource;
}

/** A rendered asset: REST gives a temporary URL; the plugin gives bytes that are saved to `file`. */
export interface Rendered {
  url?: string;
  file?: string;
  data?: Buffer;
}

export interface Screenshot extends Rendered {
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  scale: number;
  source: ReadSource;
}

/** Thrown when the node does not exist; never retried against the other source. */
export class NodeNotFoundError extends FigmaApiError {
  constructor(fileKey: string, nodeId: string) {
    super(`Node ${nodeId} was not found in file ${fileKey}.`, 404, `/v1/files/${fileKey}/nodes`);
  }
}

type PluginBytes = { __type: 'Uint8Array'; base64: string } | null | undefined;

const bytes = (v: PluginBytes): Buffer | null => (v && v.__type === 'Uint8Array' ? Buffer.from(v.base64, 'base64') : null);
const lit = (v: unknown) => JSON.stringify(v);
const slug = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'asset';

// Plugin-side snippets. Large results are returned as JSON strings, which pass through the plugin's
// result serializer untouched (it caps object depth, and node trees are deep).
const PLUGIN_NODE = (nodeId: string) => `
const node = await figma.getNodeByIdAsync(${lit(nodeId)});
if (!node) return null;
const file = { name: figma.root.name, editorType: figma.editorType };
let entry;
if (node.type === 'PAGE') {
  await node.loadAsync();
  entry = { document: { id: node.id, name: node.name, type: 'CANVAS', children: [] }, components: {}, componentSets: {}, styles: {} };
  for (const child of node.children) {
    const part = await child.exportAsync({ format: 'JSON_REST_V1' });
    entry.document.children.push(part.document);
    Object.assign(entry.components, part.components || {});
    Object.assign(entry.componentSets, part.componentSets || {});
    Object.assign(entry.styles, part.styles || {});
  }
} else if (node.type === 'DOCUMENT') {
  throw new Error('Pass a page or layer ID, not the document root.');
} else {
  entry = await node.exportAsync({ format: 'JSON_REST_V1' });
}
return JSON.stringify({ file, entry });`;

const PLUGIN_PAGES = `return JSON.stringify({ name: figma.root.name, editorType: figma.editorType, pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })) });`;

const PLUGIN_SCREENSHOT = (nodeId: string, maxDimension: number, contentsOnly: boolean) => `
const node = await figma.getNodeByIdAsync(${lit(nodeId)});
if (!node) return null;
if (node.type === 'PAGE' || node.type === 'DOCUMENT' || !('exportAsync' in node)) throw new Error('Screenshots need a layer such as a frame, not a page.');
const b = node.absoluteRenderBounds || node.absoluteBoundingBox || { width: node.width, height: node.height };
const longest = Math.max(b.width, b.height) || ${maxDimension};
const scale = Math.min(4, Math.max(0.01, ${maxDimension} / longest));
const png = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale }, contentsOnly: ${contentsOnly} });
return { png, width: b.width, height: b.height, scale };`;

const PLUGIN_EXPORT = (nodeId: string, format: string, scale: number) => `
const node = await figma.getNodeByIdAsync(${lit(nodeId)});
if (!node) return null;
const opts = { format: ${lit(format)} };
if (opts.format === 'PNG' || opts.format === 'JPG') opts.constraint = { type: 'SCALE', value: ${scale} };
return await node.exportAsync(opts);`;

const PLUGIN_SVGS = (ids: string[]) => `
const out = {};
for (const id of ${lit(ids)}) {
  const n = await figma.getNodeByIdAsync(id);
  if (n && 'exportAsync' in n) {
    try { out[id] = await n.exportAsync({ format: 'SVG' }); } catch (e) {}
  }
}
return out;`;

const PLUGIN_IMAGE_FILLS = (hashes: string[]) => `
const out = {};
for (const h of ${lit(hashes)}) {
  const img = figma.getImageByHash(h);
  if (img) {
    try { out[h] = await img.getBytesAsync(); } catch (e) {}
  }
}
return out;`;

const READ_TIMEOUT_MS = 90_000;
/**
 * Figma desktop pauses rendering for a file that is in a background tab or a minimized window, and
 * image exports wait until it is visible again. Data reads keep working, so only renders get a short
 * timeout and a hint, after which the reader falls back to REST.
 */
const RENDER_TIMEOUT_MS = 25_000;
const RENDER_HINT =
  'Figma pauses rendering while a file is in a background tab or the window is minimized; bring the file to the front in Figma desktop and retry.';

export class DesignReader {
  constructor(
    private rest: FigmaRestClient,
    private bridge: PluginBridge | null,
    private assetDir: string,
  ) {}

  /** Where reads for this file will come from right now. */
  source(fileKey: string): ReadSource {
    return this.bridge?.hasFile(fileKey) ? 'plugin' : 'rest';
  }

  private async plugin<T>(fileKey: string, code: string, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    try {
      const { result } = await this.bridge!.execute(fileKey, code, timeoutMs);
      return result as T;
    } catch (err) {
      if (timeoutMs === RENDER_TIMEOUT_MS && /timed out|did not reply/i.test(errorMessage(err))) {
        throw new Error(`The plugin did not finish rendering within ${timeoutMs / 1000}s. ${RENDER_HINT}`);
      }
      throw err;
    }
  }

  /**
   * Try the plugin when it is open in this file, falling back to REST on any plugin failure except
   * a missing node. When both fail, the error names both causes.
   */
  private async either<T>(fileKey: string, viaPlugin: () => Promise<T>, viaRest: () => Promise<T>): Promise<T> {
    if (this.source(fileKey) !== 'plugin') return viaRest();
    let pluginError: unknown;
    try {
      return await viaPlugin();
    } catch (err) {
      if (err instanceof NodeNotFoundError) throw err;
      pluginError = err;
    }
    try {
      return await viaRest();
    } catch (err) {
      throw new Error(`${errorMessage(err)} (Reading through the plugin also failed: ${errorMessage(pluginError)})`);
    }
  }

  async getNode(fileKey: string, nodeId: string): Promise<NodeRead> {
    return this.either<NodeRead>(
      fileKey,
      async () => {
        const raw = await this.plugin<string | null>(fileKey, PLUGIN_NODE(nodeId));
        if (!raw) throw new NodeNotFoundError(fileKey, nodeId);
        const { file, entry } = JSON.parse(raw);
        if (!entry?.document?.id) throw new Error('The plugin returned no node data.');
        return {
          document: entry.document,
          components: entry.components ?? {},
          componentSets: entry.componentSets ?? {},
          styles: entry.styles ?? {},
          file,
          source: 'plugin' as const,
        };
      },
      async () => {
        const { document, components, componentSets, styles, file } = await this.rest.getNode(fileKey, nodeId);
        return {
          document,
          components,
          componentSets,
          styles,
          file: { name: file.name, lastModified: file.lastModified, editorType: file.editorType },
          source: 'rest' as const,
        };
      },
    );
  }

  /** Top-level pages, as a DOCUMENT node whose children are the canvases. */
  async getPages(fileKey: string): Promise<{ name: string; document: FigmaNode; source: ReadSource }> {
    return this.either<{ name: string; document: FigmaNode; source: ReadSource }>(
      fileKey,
      async () => {
        const { name, pages } = JSON.parse(await this.plugin<string>(fileKey, PLUGIN_PAGES));
        const children = (pages as { id: string; name: string }[]).map((p) => ({ ...p, type: 'CANVAS' }));
        return { name, document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children }, source: 'plugin' as const };
      },
      async () => {
        const file = await this.rest.getFile(fileKey, { depth: 1 });
        return { name: file.name, document: file.document, source: 'rest' as const };
      },
    );
  }

  /** Render a node to PNG with its longer edge capped at maxDimension. */
  async screenshot(fileKey: string, nodeId: string, opts: { maxDimension?: number; contentsOnly?: boolean; node?: FigmaNode } = {}): Promise<Screenshot> {
    const maxDimension = opts.maxDimension ?? 1024;
    const contentsOnly = opts.contentsOnly ?? false;
    return this.either<Screenshot>(
      fileKey,
      async () => {
        const res = await this.plugin<{ png: PluginBytes; width: number; height: number; scale: number } | null>(
          fileKey,
          PLUGIN_SCREENSHOT(nodeId, maxDimension, contentsOnly),
          RENDER_TIMEOUT_MS,
        );
        if (!res) throw new NodeNotFoundError(fileKey, nodeId);
        const data = bytes(res.png);
        if (!data) throw new Error('The plugin returned no image data.');
        return {
          data,
          file: await this.save(fileKey, `screenshot-${nodeId}`, 'png', data),
          width: Math.round(res.width * res.scale),
          height: Math.round(res.height * res.scale),
          original_width: Math.round(res.width),
          original_height: Math.round(res.height),
          scale: Number(res.scale.toFixed(4)),
          source: 'plugin' as const,
        };
      },
      async () => {
        const node = opts.node ?? (await this.rest.getNode(fileKey, nodeId, { depth: 1 })).document;
        const bounds = node.absoluteRenderBounds ?? node.absoluteBoundingBox;
        const ow = bounds?.width ?? 0;
        const oh = bounds?.height ?? 0;
        const scale = Math.min(4, Math.max(0.01, maxDimension / (Math.max(ow, oh) || maxDimension)));
        const images = await this.rest.getImages(fileKey, [nodeId], { format: 'png', scale: Number(scale.toFixed(4)), contentsOnly });
        const url = images[nodeId];
        if (!url) throw new Error(`Figma returned no image for node ${nodeId}. It may be invisible or empty.`);
        return {
          url,
          width: Math.round(ow * scale),
          height: Math.round(oh * scale),
          original_width: Math.round(ow),
          original_height: Math.round(oh),
          scale: Number(scale.toFixed(4)),
          source: 'rest' as const,
        };
      },
    );
  }

  /** Export one node in a given format (png, jpg, svg, pdf). */
  async exportNode(fileKey: string, nodeId: string, format: 'png' | 'jpg' | 'svg' | 'pdf', scale: number): Promise<Rendered> {
    const vector = format === 'svg' || format === 'pdf';
    return this.either<Rendered>(
      fileKey,
      async () => {
        const data = bytes(await this.plugin<PluginBytes>(fileKey, PLUGIN_EXPORT(nodeId, format.toUpperCase(), scale), RENDER_TIMEOUT_MS));
        if (!data) throw new NodeNotFoundError(fileKey, nodeId);
        return { data, file: await this.save(fileKey, `export-${nodeId}${vector ? '' : `@${scale}x`}`, format, data) };
      },
      async () => {
        const images = await this.rest.getImages(fileKey, [nodeId], { format, scale: vector ? undefined : scale });
        return { url: images[nodeId] ?? undefined };
      },
    );
  }

  /** SVG renders for several nodes, keyed by node ID. Missing renders are simply absent. */
  async svgs(fileKey: string, nodes: { id: string; name: string }[]): Promise<Record<string, Rendered>> {
    if (!nodes.length) return {};
    return this.either(
      fileKey,
      async () => {
        const raw = await this.plugin<Record<string, PluginBytes>>(fileKey, PLUGIN_SVGS(nodes.map((n) => n.id)), RENDER_TIMEOUT_MS);
        const out: Record<string, Rendered> = {};
        for (const n of nodes) {
          const data = bytes(raw?.[n.id]);
          if (data) out[n.id] = { data, file: await this.save(fileKey, `${n.name}-${n.id}`, 'svg', data) };
        }
        return out;
      },
      async () => {
        const out: Record<string, Rendered> = {};
        for (let i = 0; i < nodes.length; i += 50) {
          const ids = nodes.slice(i, i + 50).map((n) => n.id);
          const images = await this.rest.getImages(fileKey, ids, { format: 'svg' });
          for (const id of ids) if (images[id]) out[id] = { url: images[id]! };
        }
        return out;
      },
    );
  }

  /** Original image-fill files keyed by imageRef. Plugin renders include the bytes for format sniffing. */
  async imageFills(fileKey: string, refs: string[]): Promise<Record<string, Rendered>> {
    if (!refs.length) return {};
    return this.either(
      fileKey,
      async () => {
        const raw = await this.plugin<Record<string, PluginBytes>>(fileKey, PLUGIN_IMAGE_FILLS(refs));
        const out: Record<string, Rendered> = {};
        for (const ref of refs) {
          const data = bytes(raw?.[ref]);
          if (data) out[ref] = { data, file: await this.save(fileKey, `image-${ref}`, extensionFor(data), data) };
        }
        return out;
      },
      async () => {
        const fills = await this.rest.getImageFills(fileKey);
        const out: Record<string, Rendered> = {};
        for (const ref of refs) if (fills[ref]) out[ref] = { url: fills[ref] };
        return out;
      },
    );
  }

  private async save(fileKey: string, name: string, ext: string, data: Buffer): Promise<string> {
    const dir = path.join(this.assetDir, slug(fileKey));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slug(name)}.${ext}`);
    await writeFile(file, data);
    // Forward slashes read cleanly inside generated code and work on Windows too.
    return file.split(path.sep).join('/');
  }
}

function extensionFor(data: Buffer): string {
  const fmt = sniffFormat(data);
  return fmt === 'jpeg' ? 'jpg' : fmt === 'original' ? 'bin' : fmt;
}
