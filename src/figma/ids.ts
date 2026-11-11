export type FigmaFileKind = 'design' | 'board' | 'slides' | 'make' | 'proto' | 'file' | 'unknown';

export interface ParsedFigmaUrl {
  fileKey: string;
  nodeId?: string;
  kind: FigmaFileKind;
}

/**
 * Normalize "1-2", "1:2", "I1-2;3-4" and URL-encoded variants to the colon form the REST API expects.
 */
export function normalizeNodeId(raw: string): string {
  const decoded = decodeURIComponent(raw.trim());
  return decoded.replace(/(\d+)-(\d+)/g, '$1:$2');
}

/**
 * Parse a figma.com URL. Branch URLs resolve to the branch key, matching the official server's guidance.
 */
export function parseFigmaUrl(input: string): ParsedFigmaUrl | null {
  let url: URL;
  try {
    url = new URL(input.startsWith('http') ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const kind = (['design', 'board', 'slides', 'make', 'proto', 'file'].includes(parts[0]) ? parts[0] : 'unknown') as FigmaFileKind;
  let fileKey = parts[1];
  const branchIdx = parts.indexOf('branch');
  if (branchIdx !== -1 && parts[branchIdx + 1]) fileKey = parts[branchIdx + 1];
  const nodeParam = url.searchParams.get('node-id');
  return { fileKey, kind, nodeId: nodeParam ? normalizeNodeId(nodeParam) : undefined };
}

/**
 * Accept either a bare file key or a pasted URL in the fileKey argument, and a nodeId that may be in dash form.
 */
export function resolveTarget(fileKey: string, nodeId?: string): { fileKey: string; nodeId?: string; kind: FigmaFileKind } {
  const trimmed = fileKey.trim();
  if (trimmed.includes('figma.com')) {
    const parsed = parseFigmaUrl(trimmed);
    if (!parsed) throw new Error(`Could not parse a file key from "${fileKey}".`);
    return { fileKey: parsed.fileKey, nodeId: nodeId ? normalizeNodeId(nodeId) : parsed.nodeId, kind: parsed.kind };
  }
  return { fileKey: trimmed, nodeId: nodeId ? normalizeNodeId(nodeId) : undefined, kind: 'unknown' };
}
