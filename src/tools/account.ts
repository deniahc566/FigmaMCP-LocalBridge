import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errorMessage } from '../util.js';
import { guarded, json, toolName, type ToolDeps } from './common.js';

export function registerAccountTools(server: McpServer, deps: ToolDeps) {
  server.registerTool(
    toolName(deps.config.toolPrefix, 'whoami'),
    {
      title: 'Who am I',
      description:
        'Returns the authenticated Figma user (handle, email, id), how this server authenticates, the tool name prefix, and the status of the companion plugin bridge (which files have the plugin open, their current page and selection). ' +
        `Use this tool when you hit file access or permission errors, rate limits, or when ${toolName(deps.config.toolPrefix, 'use_figma')} cannot find the plugin.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => {
      let user: unknown = null;
      let authError: string | undefined;
      if (deps.rest.hasToken) {
        try {
          user = await deps.rest.getMe();
        } catch (err) {
          authError = errorMessage(err);
        }
      } else {
        authError = 'No token configured. Set FIGMA_ACCESS_TOKEN (personal access token) or FIGMA_OAUTH_TOKEN.';
      }
      return {
        content: [
          json({
            user,
            auth: { method: deps.rest.tokenKind, error: authError },
            teamId: deps.config.teamId ?? null,
            toolPrefix: deps.config.toolPrefix,
            bridge: deps.bridge
              ? {
                  mode: deps.bridge.mode,
                  listening: deps.bridge.listening,
                  port: deps.bridge.port ?? null,
                  relayPort: deps.bridge.relayPort ?? null,
                  plugins: deps.bridge.list(),
                }
              : { listening: false, disabled: true },
          }),
        ],
      };
    }),
  );
}
