import os from 'node:os';
import path from 'node:path';

export interface Config {
  /** Personal access token, sent as X-Figma-Token. */
  accessToken?: string;
  /** OAuth access token, sent as Authorization: Bearer. Takes precedence over accessToken. */
  oauthToken?: string;
  apiBase: string;
  /** Optional team ID so library tools can list the team's published components and styles. */
  teamId?: string;
  bridgeEnabled: boolean;
  bridgeHost: string;
  /** Ports the plugin bridge tries in order; the plugin UI connects to every one of them. */
  bridgePorts: number[];
  /** Secret that instances present to relay through another instance when every port is taken. */
  bridgeSecretFile: string;
  /** Default timeout for code run through the plugin bridge. */
  bridgeTimeoutMs: number;
  /**
   * Prepended to every tool name so this server's tools never collide with the official Figma MCP
   * (or other Figma servers) loaded in the same client. Empty string restores the official names.
   */
  toolPrefix: string;
  /** Where screenshots and assets rendered by the plugin are saved (the plugin returns bytes, not URLs). */
  assetDir: string;
}

export const DEFAULT_TOOL_PREFIX = 'figma_local_';

function parsePrefix(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_TOOL_PREFIX;
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) throw new Error(`FIGMA_TOOL_PREFIX may only contain letters, digits, "_" and "-" (got "${raw}").`);
  return raw;
}

function parsePorts(raw: string | undefined): number[] {
  if (!raw) return [3850, 3851, 3852, 3853, 3854];
  const ports: number[] = [];
  for (const part of raw.split(',')) {
    const range = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!range) continue;
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    for (let p = start; p <= end; p++) ports.push(p);
  }
  return ports.length ? ports : [3850];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    accessToken: env.FIGMA_ACCESS_TOKEN || env.FIGMA_API_KEY || undefined,
    oauthToken: env.FIGMA_OAUTH_TOKEN || undefined,
    apiBase: (env.FIGMA_API_BASE || 'https://api.figma.com').replace(/\/+$/, ''),
    teamId: env.FIGMA_TEAM_ID || undefined,
    bridgeEnabled: env.FIGMA_BRIDGE !== 'off',
    bridgeHost: env.FIGMA_BRIDGE_HOST || '127.0.0.1',
    bridgePorts: parsePorts(env.FIGMA_BRIDGE_PORTS),
    bridgeSecretFile: env.FIGMA_BRIDGE_SECRET_FILE || path.join(os.homedir(), '.figma-mcp', 'bridge-secret'),
    bridgeTimeoutMs: Number(env.FIGMA_BRIDGE_TIMEOUT_MS) || 60_000,
    toolPrefix: parsePrefix(env.FIGMA_TOOL_PREFIX),
    assetDir: env.FIGMA_ASSET_DIR || path.join(os.tmpdir(), 'figma-mcp-assets'),
  };
}
