import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PublishedAsset } from '../figma/types.js';
import { errorMessage, mapLimit, TtlCache } from '../util.js';
import { fileKeyParam, guarded, json, target, toolName, type ToolBase, type ToolDeps } from './common.js';

type Entity = 'component' | 'style' | 'variable';

interface Asset {
  entity: Entity;
  name: string;
  type: string;
  key?: string;
  id?: string;
  description?: string;
  library: string;
  libraryKey?: string;
  nodeId?: string;
  path?: string;
  thumbnailUrl?: string;
  variants?: number;
  resolvedType?: string;
  collection?: string;
}

const PLUGIN_VARIABLES = `
const out = [];
const cols = {};
for (const c of await figma.variables.getLocalVariableCollectionsAsync()) cols[c.id] = c.name;
for (const v of await figma.variables.getLocalVariablesAsync()) {
  out.push({ name: v.name, key: v.key, id: v.id, resolvedType: v.resolvedType, collection: cols[v.variableCollectionId], library: null });
}
try {
  const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  for (const lc of libs.slice(0, 40)) {
    for (const v of await figma.teamLibrary.getVariablesInLibraryCollectionAsync(lc.key)) {
      out.push({ name: v.name, key: v.key, resolvedType: v.resolvedType, collection: lc.name, library: lc.libraryName });
    }
  }
} catch (e) {}
return out;`;

// Whole-file index built inside the plugin. Returned as a JSON string to bypass the plugin's
// result-depth limit and keep large files fast.
const PLUGIN_INDEX = `
await figma.loadAllPagesAsync();
const pageOf = (n) => { let p = n.parent; while (p && p.type !== 'PAGE') p = p.parent; return p ? p.name : undefined; };
const components = [];
for (const n of figma.root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })) {
  if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') continue;
  components.push({ id: n.id, key: n.key, name: n.name, type: n.type, description: n.description || undefined, variants: n.type === 'COMPONENT_SET' ? n.children.length : undefined, page: pageOf(n) });
}
const styles = [];
const kinds = [['FILL', await figma.getLocalPaintStylesAsync()], ['TEXT', await figma.getLocalTextStylesAsync()], ['EFFECT', await figma.getLocalEffectStylesAsync()], ['GRID', await figma.getLocalGridStylesAsync()]];
for (const [type, list] of kinds) for (const s of list) styles.push({ id: s.id, key: s.key, name: s.name, type, description: s.description || undefined });
const variables = [];
const cols = {};
for (const c of await figma.variables.getLocalVariableCollectionsAsync()) cols[c.id] = c.name;
for (const v of await figma.variables.getLocalVariablesAsync()) {
  variables.push({ id: v.id, key: v.key, name: v.name, resolvedType: v.resolvedType, collection: cols[v.variableCollectionId], library: null });
}
try {
  const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  for (const lc of libs.slice(0, 40)) {
    for (const v of await figma.teamLibrary.getVariablesInLibraryCollectionAsync(lc.key)) {
      variables.push({ key: v.key, name: v.name, resolvedType: v.resolvedType, collection: lc.name, library: lc.libraryName });
    }
  }
} catch (e) {}
return JSON.stringify({ file: figma.root.name, components, styles, variables });`;

interface PluginIndex {
  file: string;
  components: { id: string; key: string; name: string; type: string; description?: string; variants?: number; page?: string }[];
  styles: { id: string; key: string; name: string; type: string; description?: string }[];
  variables: { id?: string; key: string; name: string; resolvedType: string; collection?: string; library: string | null }[];
}

const PLUGIN_VARIABLE_LIBRARIES = `
const libs = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
return libs.map((c) => ({ libraryName: c.libraryName, collection: c.name, key: c.key }));`;

const indexCache = new TtlCache<Asset[]>(2 * 60_000, 20);

function normalize(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[\/_\-.,=:()]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function score(asset: Asset, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const name = normalize(asset.name);
  const last = normalize(asset.name.split('/').pop());
  if (name === q || last === q) return 100;
  if (last.startsWith(q) || name.startsWith(q)) return 80;
  if (name.includes(q)) return 65;
  const tokens = q.split(' ');
  const hay = `${name} ${normalize(asset.path)} ${normalize(asset.description)} ${normalize(asset.collection)}`;
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return hits ? 20 + (40 * hits) / tokens.length : 0;
}

function fromPublished(entity: Entity, a: PublishedAsset, library: string, type: string): Asset {
  return {
    entity,
    name: a.name,
    type,
    key: a.key,
    description: a.description || undefined,
    library,
    libraryKey: a.file_key,
    nodeId: a.node_id,
    path: [a.containing_frame?.pageName, a.containing_frame?.name].filter(Boolean).join(' / ') || undefined,
    thumbnailUrl: a.thumbnail_url,
  };
}

async function buildIndex(deps: ToolDeps, fileKey: string): Promise<{ assets: Asset[]; notes: string[] }> {
  const notes: string[] = [];
  const cached = indexCache.get(fileKey);
  if (cached) return { assets: cached, notes };

  const byKey = new Map<string, Asset>();
  const add = (a: Asset) => {
    const id = a.key ?? `${a.entity}:${a.id ?? a.name}`;
    const prev = byKey.get(id);
    // Prefer entries that know which library they come from.
    if (!prev || (!prev.libraryKey && a.libraryKey)) byKey.set(id, a);
  };

  // 1. Everything the file defines: from the plugin when it is open (no REST quota), else the file JSON.
  let fileName = fileKey;
  let gotVariables = false;
  let fromPlugin = false;
  if (deps.bridge?.hasFile(fileKey)) {
    try {
      const { result } = await deps.bridge.execute(fileKey, PLUGIN_INDEX, 90_000);
      const idx = JSON.parse(result as string) as PluginIndex;
      fileName = idx.file;
      for (const c of idx.components) {
        add({ entity: 'component', name: c.name, type: c.type, key: c.key, id: c.id, description: c.description, library: idx.file, libraryKey: fileKey, nodeId: c.id, path: c.page, variants: c.variants });
      }
      for (const st of idx.styles) {
        add({ entity: 'style', name: st.name, type: st.type, key: st.key, id: st.id, description: st.description, library: idx.file, libraryKey: fileKey });
      }
      for (const v of idx.variables) {
        add({ entity: 'variable', name: v.name, type: 'VARIABLE', key: v.key, id: v.id, resolvedType: v.resolvedType, collection: v.collection, library: v.library ?? idx.file, libraryKey: v.library ? undefined : fileKey });
      }
      fromPlugin = true;
      gotVariables = true;
      notes.push('Indexed through the Figma MCP Bridge plugin: local components, styles and variables plus library variables. Library components and styles need FIGMA_TEAM_ID.');
    } catch (err) {
      notes.push(`Indexing through the plugin failed (${errorMessage(err)}); used the REST API instead.`);
    }
  }
  if (!fromPlugin) {
    const file = await deps.rest.getFile(fileKey);
    fileName = file.name;
    const setCounts = new Map<string, number>();
    for (const c of Object.values(file.components)) if (c.componentSetId) setCounts.set(c.componentSetId, (setCounts.get(c.componentSetId) ?? 0) + 1);
    for (const [id, set] of Object.entries(file.componentSets)) {
      add({
        entity: 'component',
        name: set.name,
        type: 'COMPONENT_SET',
        key: set.key,
        id,
        description: set.description || undefined,
        library: set.remote ? 'Library (used in this file)' : file.name,
        libraryKey: set.remote ? undefined : fileKey,
        nodeId: set.remote ? undefined : id,
        variants: setCounts.get(id),
      });
    }
    for (const [id, c] of Object.entries(file.components)) {
      if (c.componentSetId && file.componentSets[c.componentSetId]) continue;
      add({
        entity: 'component',
        name: c.name,
        type: 'COMPONENT',
        key: c.key,
        id,
        description: c.description || undefined,
        library: c.remote ? 'Library (used in this file)' : file.name,
        libraryKey: c.remote ? undefined : fileKey,
        nodeId: c.remote ? undefined : id,
      });
    }
    for (const [id, st] of Object.entries(file.styles)) {
      add({
        entity: 'style',
        name: st.name,
        type: st.styleType,
        key: st.key,
        id,
        description: st.description || undefined,
        library: st.remote ? 'Library (used in this file)' : file.name,
        libraryKey: st.remote ? undefined : fileKey,
      });
    }
  }

  // 2. The team's published libraries, when a team ID is configured.
  const teamId = deps.config.teamId;
  if (teamId) {
    try {
      const [files, comps, sets, styles] = await Promise.all([
        deps.rest.getTeamFiles(teamId).catch(() => []),
        deps.rest.getTeamPublished(teamId, 'components'),
        deps.rest.getTeamPublished(teamId, 'component_sets'),
        deps.rest.getTeamPublished(teamId, 'styles'),
      ]);
      const names = new Map(files.map((f) => [f.key, f.name]));
      const libName = (k: string) => names.get(k) ?? `Library ${k}`;
      for (const s of sets) add(fromPublished('component', s, libName(s.file_key), 'COMPONENT_SET'));
      for (const c of comps) if (!c.containing_frame?.containingComponentSet) add(fromPublished('component', c, libName(c.file_key), 'COMPONENT'));
      for (const s of styles) add(fromPublished('style', s, libName(s.file_key), s.style_type ?? 'STYLE'));
    } catch (err) {
      notes.push(`Team library search failed: ${(err as Error).message}`);
    }
  } else {
    notes.push('Set FIGMA_TEAM_ID to also search every library your team has published.');
  }

  // 3. Variables, unless the plugin index already had them: plugin first, REST on Enterprise as fallback.
  if (!gotVariables && deps.bridge?.hasFile(fileKey)) {
    try {
      const { result } = await deps.bridge.execute(fileKey, PLUGIN_VARIABLES, 30_000);
      for (const v of (result ?? []) as any[]) {
        add({ entity: 'variable', name: v.name, type: 'VARIABLE', key: v.key, id: v.id, resolvedType: v.resolvedType, collection: v.collection, library: v.library ?? fileName, libraryKey: v.library ? undefined : fileKey });
      }
      gotVariables = true;
    } catch {
      // Fall through.
    }
  }
  if (!gotVariables) {
    try {
      const meta = await deps.rest.getLocalVariables(fileKey);
      for (const v of Object.values(meta.variables)) {
        if (v.remote) continue;
        add({ entity: 'variable', name: v.name, type: 'VARIABLE', key: v.key, id: v.id, resolvedType: v.resolvedType, collection: meta.variableCollections[v.variableCollectionId]?.name, library: fileName, libraryKey: fileKey });
      }
      gotVariables = true;
    } catch {
      notes.push('Variables were not searched: run the companion plugin in this file (or use an Enterprise token) to include them.');
    }
  }

  const assets = [...byKey.values()];
  indexCache.set(fileKey, assets);
  return { assets, notes };
}

export function registerLibraryTools(server: McpServer, deps: ToolDeps) {
  const n = (base: ToolBase) => toolName(deps.config.toolPrefix, base);

  server.registerTool(
    n('search_design_system'),
    {
      title: 'Search design system',
      description:
        'Search for design system assets (components, variables and styles) in the file and in the team\'s libraries. Pass `queries` as an array of objects, each with `entity` ("component", "variable" or "style") and a string `query`, e.g. {"fileKey":"<file key>","queries":[{"entity":"component","query":"button"},{"entity":"variable","query":"surface"}]}. Combine the searches the task needs in one call. Results come back in a `results` array in the same order as `queries`.',
      inputSchema: {
        fileKey: fileKeyParam,
        queries: z
          .array(
            z.object({
              entity: z.enum(['component', 'variable', 'style']).describe('Asset type: exactly "component", "variable" or "style".'),
              query: z.string().describe('One asset name or short phrase to find. One search intent per query.'),
            }),
          )
          .min(1)
          .describe('Array of search objects. Results are returned in the same order.'),
        includeLibraryKeys: z.array(z.string()).optional().describe(`Restrict results to these library keys (library file keys, as returned by ${n('get_libraries')} or earlier results).`),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum matches per query. Defaults to 10.'),
        disableCodeConnect: z.boolean().optional().describe('Accepted for compatibility; this server does not attach Code Connect data to search results.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey);
      const { assets, notes } = await buildIndex(deps, t.fileKey);
      const allow = args.includeLibraryKeys?.length ? new Set(args.includeLibraryKeys) : null;
      const limit = args.limit ?? 10;
      const results = args.queries.map(({ entity, query }) => {
        const matches = assets
          .filter((a) => a.entity === entity && (!allow || (a.libraryKey && allow.has(a.libraryKey))))
          .map((a) => ({ a, s: score(a, query) }))
          .filter((m) => m.s > 0)
          .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
          .slice(0, limit)
          .map(({ a }) => {
            const { entity: _e, ...rest } = a;
            return rest;
          });
        return { entity, query, matches };
      });
      return { content: [json({ results, ...(notes.length ? { notes } : {}) })] };
    }),
  );

  server.registerTool(
    n('get_libraries'),
    {
      title: 'Get libraries',
      description:
        "Get the design libraries associated with a Figma file. Returns (1) libraries in use by the file (the libraries its component instances and styles come from) and (2) libraries available to add (the team's published libraries, when FIGMA_TEAM_ID is set). Each library has a name and library key (the library file key). The available list is paginated: pass libraries_available_to_add_next_offset back as offset. " +
        `Use library keys to scope ${n('search_design_system')} via includeLibraryKeys.`,
      inputSchema: {
        fileKey: fileKeyParam,
        offset: z.number().int().min(0).optional().describe('Pagination offset from a previous response (libraries_available_to_add_next_offset).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const t = target(args.fileKey);
      const notes: string[] = [];
      let file;
      try {
        file = await deps.rest.getFile(t.fileKey);
      } catch (err) {
        // Library usage is only visible through REST. When it is unavailable (for example rate
        // limited) but the plugin is open, report the libraries the plugin can see.
        if (!deps.bridge?.hasFile(t.fileKey)) throw err;
        const { result } = await deps.bridge.execute(t.fileKey, PLUGIN_VARIABLE_LIBRARIES, 20_000);
        return {
          content: [
            json({
              file: { key: t.fileKey },
              libraries_in_use: [],
              libraries_available_to_add: [],
              variable_library_collections: result,
              notes: [`The REST API is unavailable (${errorMessage(err)}), so only libraries visible to the plugin are listed: variable collections from enabled libraries.`],
            }),
          ],
        };
      }

      // Resolve which library file each remote asset comes from. Component sets stand in for their variants.
      const lookups: { kind: 'components' | 'component_sets' | 'styles'; key: string; bucket: 'components' | 'styles' }[] = [];
      for (const s of Object.values(file.componentSets)) if (s.remote) lookups.push({ kind: 'component_sets', key: s.key, bucket: 'components' });
      for (const c of Object.values(file.components)) {
        if (c.remote && !(c.componentSetId && file.componentSets[c.componentSetId])) lookups.push({ kind: 'components', key: c.key, bucket: 'components' });
      }
      for (const s of Object.values(file.styles)) if (s.remote) lookups.push({ kind: 'styles', key: s.key, bucket: 'styles' });
      const MAX_LOOKUPS = 60;
      if (lookups.length > MAX_LOOKUPS) notes.push(`Checked ${MAX_LOOKUPS} of ${lookups.length} library assets used in the file; counts are a sample.`);

      const inUse = new Map<string, { components: number; styles: number }>();
      await mapLimit(lookups.slice(0, MAX_LOOKUPS), 6, async (l) => {
        try {
          const meta = await deps.rest.getPublishedAsset(l.kind, l.key);
          const entry = inUse.get(meta.file_key) ?? { components: 0, styles: 0 };
          entry[l.bucket]++;
          inUse.set(meta.file_key, entry);
        } catch {
          // Asset from a library the token cannot read.
        }
      });

      const teamFiles = deps.config.teamId ? await deps.rest.getTeamFiles(deps.config.teamId).catch(() => []) : [];
      const teamNames = new Map(teamFiles.map((f) => [f.key, f.name]));
      const nameOf = async (key: string) => {
        if (teamNames.has(key)) return teamNames.get(key)!;
        try {
          return (await deps.rest.getFile(key, { depth: 1 })).name;
        } catch {
          return `Library ${key}`;
        }
      };

      const librariesInUse = await mapLimit([...inUse], 4, async ([key, counts]) => ({
        name: await nameOf(key),
        library_key: key,
        source_type: 'library_in_use',
        components_used: counts.components,
        styles_used: counts.styles,
      }));

      const [ownComponents, ownSets, ownStyles] = await Promise.all([
        deps.rest.getFilePublished(t.fileKey, 'components').catch(() => []),
        deps.rest.getFilePublished(t.fileKey, 'component_sets').catch(() => []),
        deps.rest.getFilePublished(t.fileKey, 'styles').catch(() => []),
      ]);

      let available: Record<string, unknown>[] = [];
      let nextOffset: number | undefined;
      if (deps.config.teamId) {
        const [comps, styles] = await Promise.all([
          deps.rest.getTeamPublished(deps.config.teamId, 'components').catch(() => []),
          deps.rest.getTeamPublished(deps.config.teamId, 'styles').catch(() => []),
        ]);
        const counts = new Map<string, { components: number; styles: number }>();
        for (const c of comps) {
          const e = counts.get(c.file_key) ?? { components: 0, styles: 0 };
          e.components++;
          counts.set(c.file_key, e);
        }
        for (const s of styles) {
          const e = counts.get(s.file_key) ?? { components: 0, styles: 0 };
          e.styles++;
          counts.set(s.file_key, e);
        }
        const all = [...counts]
          .filter(([key]) => !inUse.has(key) && key !== t.fileKey)
          .map(([key, c]) => ({
            name: teamNames.get(key) ?? `Library ${key}`,
            library_key: key,
            source_type: 'team_library',
            published_components: c.components,
            published_styles: c.styles,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const offset = args.offset ?? 0;
        const PAGE = 25;
        available = all.slice(offset, offset + PAGE);
        if (offset + PAGE < all.length) nextOffset = offset + PAGE;
      } else {
        notes.push('Set FIGMA_TEAM_ID to list the team libraries available to add.');
      }

      let variableLibraries: unknown;
      if (deps.bridge?.hasFile(t.fileKey)) {
        try {
          variableLibraries = (await deps.bridge.execute(t.fileKey, PLUGIN_VARIABLE_LIBRARIES, 20_000)).result;
        } catch {
          // Optional.
        }
      }

      return {
        content: [
          json({
            file: { name: file.name, key: t.fileKey },
            libraries_in_use: librariesInUse,
            this_file_publishes:
              ownComponents.length || ownSets.length || ownStyles.length
                ? { components: ownComponents.length, component_sets: ownSets.length, styles: ownStyles.length }
                : undefined,
            libraries_available_to_add: available,
            libraries_available_to_add_next_offset: nextOffset,
            variable_library_collections: variableLibraries,
            notes: [
              'The REST API does not expose which libraries are toggled on for a file; "in use" lists the libraries the file\'s instances and styles come from.',
              ...notes,
            ],
          }),
        ],
      };
    }),
  );
}
