import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PluginBridge } from './bridge/server.js';
import type { Config } from './config.js';
import { DesignReader } from './figma/reader.js';
import { FigmaRestClient } from './figma/rest.js';
import { VariableResolver } from './figma/variables.js';
import { registerAccountTools } from './tools/account.js';
import { toolName, type ToolBase, type ToolDeps } from './tools/common.js';
import { registerDesignTools } from './tools/design.js';
import { registerLibraryTools } from './tools/library.js';
import { registerWriteTools } from './tools/write.js';

export const SERVER_NAME = 'figma-mcp';
export const SERVER_VERSION = '0.1.0';

function instructions(prefix: string): string {
  const n = (base: ToolBase) => toolName(prefix, base);
  const naming = prefix
    ? `\nEvery tool here is named "${prefix}<official name>" (e.g. ${n('get_design_context')}) so it never collides with the official Figma MCP or other Figma servers connected at the same time. Skills and prompts written for the official tools apply: call the ${prefix}-prefixed equivalent.\n`
    : '';
  return `A self-hosted Figma MCP server with the same tool interface as the official Figma MCP server.
Use it whenever the user mentions Figma, shares a figma.com URL, or wants to implement, inspect, create or edit a design.
${naming}
READ (Figma REST API, needs FIGMA_ACCESS_TOKEN):
- ${n('get_design_context')}: primary design-to-code tool. React + Tailwind reference code, assets, tokens, components, screenshot.
- ${n('get_metadata')}: XML structure of a node, or the page list when nodeId is omitted.
- ${n('get_screenshot')}, ${n('get_variable_defs')}, ${n('get_figjam')}, ${n('download_assets')}, ${n('get_code_connect_map')}.
- ${n('search_design_system')}, ${n('get_libraries')}: find components, styles and variables to reuse.

WRITE (companion plugin, needs the "Figma MCP Bridge" plugin running in the file in Figma desktop):
- ${n('use_figma')}: run Plugin API JavaScript in the open file to create or edit anything.

URLS: for https://figma.com/design/:fileKey/:fileName?node-id=1-2 use fileKey=:fileKey and nodeId=1:2.
For branch URLs (/design/:fileKey/branch/:branchKey/...) use the branchKey as fileKey. FigJam boards use /board/.

Generated code is a reference, not final code: adapt it to the project's framework, components and design tokens.
If a tool fails with permission, rate-limit or plugin errors, call ${n('whoami')} to diagnose.`;
}

export function createServer(config: Config, bridge: PluginBridge | null): McpServer {
  const rest = new FigmaRestClient(config);
  const deps: ToolDeps = {
    config,
    rest,
    bridge,
    variables: new VariableResolver(rest, bridge),
    reader: new DesignReader(rest, bridge, config.assetDir),
  };
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: instructions(config.toolPrefix) });
  registerDesignTools(server, deps);
  registerLibraryTools(server, deps);
  registerWriteTools(server, deps);
  registerAccountTools(server, deps);
  return server;
}
