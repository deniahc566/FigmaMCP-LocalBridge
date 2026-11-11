import type { Config } from '../config.js';
import { TtlCache } from '../util.js';
import type {
  FileResponse,
  NodesResponse,
  PublishedAsset,
  RestVariable,
  RestVariableCollection,
} from './types.js';

export class FigmaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'FigmaApiError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export interface ImageOptions {
  format?: 'png' | 'jpg' | 'svg' | 'pdf';
  scale?: number;
  contentsOnly?: boolean;
  useAbsoluteBounds?: boolean;
  svgOutlineText?: boolean;
}

const MAX_RETRIES = 3;
/** Wait at most this long on a 429 before giving up and reporting the limit to the caller. */
const MAX_RETRY_WAIT_MS = 20_000;

function hint(status: number): string {
  switch (status) {
    case 400:
      return 'Check the file key and node ID format.';
    case 403:
      return 'The token cannot read this resource. Check that the token is valid, has the scope this call needs (see the README scope table), and that your account can open the file.';
    case 404:
      return 'The file or node was not found. For branch URLs, pass the branch key as fileKey.';
    case 429:
      return 'Figma rate limit reached. Run the Figma MCP Bridge plugin in this file: read tools then go through the plugin and need no REST quota. Otherwise wait before retrying.';
    default:
      return '';
  }
}

export class FigmaRestClient {
  private fileCache = new TtlCache<FileResponse>(60_000, 10);
  private nodesCache = new TtlCache<NodesResponse>(60_000, 50);
  private libraryCache = new TtlCache<unknown>(5 * 60_000, 200);

  constructor(private config: Config) {}

  get hasToken(): boolean {
    return Boolean(this.config.oauthToken || this.config.accessToken);
  }

  get tokenKind(): 'oauth' | 'personal-access-token' | 'none' {
    if (this.config.oauthToken) return 'oauth';
    if (this.config.accessToken) return 'personal-access-token';
    return 'none';
  }

  private headers(): Record<string, string> {
    if (this.config.oauthToken) return { Authorization: `Bearer ${this.config.oauthToken}` };
    if (this.config.accessToken) return { 'X-Figma-Token': this.config.accessToken };
    throw new Error('No Figma token configured. Set FIGMA_ACCESS_TOKEN (personal access token) or FIGMA_OAUTH_TOKEN in the MCP server environment.');
  }

  async request<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(this.config.apiBase + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: this.headers() });
      if (res.ok) return (await res.json()) as T;

      const retryAfterSec = Number(res.headers.get('retry-after'));
      const retryable = res.status === 429 || res.status >= 500;
      const waitMs = res.status === 429 && retryAfterSec > 0 ? retryAfterSec * 1000 : 500 * 2 ** attempt;
      if (retryable && attempt < MAX_RETRIES && waitMs <= MAX_RETRY_WAIT_MS) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      let detail = '';
      try {
        const body = (await res.json()) as { err?: string; message?: string; error?: string | boolean };
        detail = body.err || body.message || (typeof body.error === 'string' ? body.error : '') || '';
      } catch {
        // Non-JSON error body; the status code is enough.
      }
      const retryNote = res.status === 429 && retryAfterSec > 0 ? ` Retry after ${retryAfterSec}s.` : '';
      throw new FigmaApiError(
        `Figma API ${res.status} on ${path}${detail ? `: ${detail}` : ''}. ${hint(res.status)}${retryNote}`.trim(),
        res.status,
        path,
      );
    }
  }

  getMe() {
    return this.request<{ id: string; email: string; handle: string; img_url: string }>('/v1/me');
  }

  /** Whole-file fetch. Cached briefly because library tools may call it several times per request. */
  getFile(fileKey: string, opts: { depth?: number } = {}): Promise<FileResponse> {
    const cacheKey = `${fileKey}:${opts.depth ?? 'all'}`;
    return this.fileCache.getOrLoad(cacheKey, () => this.request<FileResponse>(`/v1/files/${fileKey}`, { depth: opts.depth }));
  }

  getNodes(fileKey: string, ids: string[], opts: { depth?: number } = {}): Promise<NodesResponse> {
    const cacheKey = `${fileKey}:${ids.join(',')}:${opts.depth ?? 'all'}`;
    return this.nodesCache.getOrLoad(cacheKey, () =>
      this.request<NodesResponse>(`/v1/files/${fileKey}/nodes`, { ids: ids.join(','), depth: opts.depth }),
    );
  }

  /** Fetch one node, throwing a clear error when the ID does not exist in the file. */
  async getNode(fileKey: string, nodeId: string, opts: { depth?: number } = {}) {
    const res = await this.getNodes(fileKey, [nodeId], opts);
    const entry = res.nodes[nodeId];
    if (!entry) throw new FigmaApiError(`Node ${nodeId} was not found in file ${fileKey}.`, 404, `/v1/files/${fileKey}/nodes`);
    return { file: res, ...entry };
  }

  async getImages(fileKey: string, ids: string[], opts: ImageOptions = {}): Promise<Record<string, string | null>> {
    if (ids.length === 0) return {};
    const res = await this.request<{ err: string | null; images: Record<string, string | null> }>(`/v1/images/${fileKey}`, {
      ids: ids.join(','),
      format: opts.format,
      scale: opts.scale,
      contents_only: opts.contentsOnly,
      use_absolute_bounds: opts.useAbsoluteBounds,
      svg_outline_text: opts.svgOutlineText,
    });
    if (res.err) throw new FigmaApiError(`Figma could not render images: ${res.err}`, 400, `/v1/images/${fileKey}`);
    return res.images;
  }

  /** Download URLs for every image fill in the file, keyed by imageRef. */
  async getImageFills(fileKey: string): Promise<Record<string, string>> {
    const res = await this.request<{ meta: { images: Record<string, string> } }>(`/v1/files/${fileKey}/images`);
    return res.meta?.images ?? {};
  }

  getFilePublished(fileKey: string, kind: 'components' | 'component_sets' | 'styles'): Promise<PublishedAsset[]> {
    return this.cached(`file:${fileKey}:${kind}`, async () => {
      const res = await this.request<{ meta: Record<string, PublishedAsset[]> }>(`/v1/files/${fileKey}/${kind}`);
      return res.meta?.[kind] ?? [];
    });
  }

  /** All published assets of one kind for a team, following the cursor up to maxPages. */
  getTeamPublished(teamId: string, kind: 'components' | 'component_sets' | 'styles', maxPages = 10): Promise<PublishedAsset[]> {
    return this.cached(`team:${teamId}:${kind}`, async () => {
      const all: PublishedAsset[] = [];
      let after: number | undefined;
      for (let page = 0; page < maxPages; page++) {
        const res = await this.request<{ meta: Record<string, unknown> & { cursor?: { after?: number } } }>(
          `/v1/teams/${teamId}/${kind}`,
          { page_size: 1000, after },
        );
        all.push(...((res.meta?.[kind] as PublishedAsset[] | undefined) ?? []));
        after = res.meta?.cursor?.after;
        if (!after) break;
      }
      return all;
    });
  }

  getTeamFiles(teamId: string): Promise<{ key: string; name: string; project: string }[]> {
    return this.cached(`team:${teamId}:files`, async () => {
      const projects = await this.request<{ projects: { id: string; name: string }[] }>(`/v1/teams/${teamId}/projects`);
      const files: { key: string; name: string; project: string }[] = [];
      for (const project of projects.projects ?? []) {
        const res = await this.request<{ files: { key: string; name: string }[] }>(`/v1/projects/${project.id}/files`);
        for (const f of res.files ?? []) files.push({ key: f.key, name: f.name, project: project.name });
      }
      return files;
    });
  }

  getPublishedAsset(kind: 'components' | 'component_sets' | 'styles', key: string): Promise<PublishedAsset> {
    return this.cached(`asset:${kind}:${key}`, async () => {
      const res = await this.request<{ meta: PublishedAsset }>(`/v1/${kind}/${key}`);
      return res.meta;
    });
  }

  /** Local variables. Figma only grants this endpoint on Enterprise plans, so callers must handle 403. */
  getLocalVariables(fileKey: string) {
    return this.cached(`vars:${fileKey}`, async () => {
      const res = await this.request<{
        meta: { variables: Record<string, RestVariable>; variableCollections: Record<string, RestVariableCollection> };
      }>(`/v1/files/${fileKey}/variables/local`);
      return res.meta;
    });
  }

  async getDevResources(fileKey: string, nodeIds?: string[]) {
    const res = await this.request<{ dev_resources: { id: string; name: string; url: string; file_key: string; node_id: string }[] }>(
      `/v1/files/${fileKey}/dev_resources`,
      { node_ids: nodeIds?.join(',') },
    );
    return res.dev_resources ?? [];
  }

  /** Download a URL returned by the API (image renders are served from a CDN without auth). */
  async fetchBinary(url: string, range?: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await fetch(url, range ? { headers: { Range: range } } : undefined);
    if (!res.ok && res.status !== 206) throw new Error(`Download failed with ${res.status} for ${url}`);
    return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.libraryCache.getOrLoad(key, load) as Promise<T>;
  }
}
