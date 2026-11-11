# figma-mcp

> 📘 **Hướng dẫn tiếng Việt:** [HUONG-DAN.md](HUONG-DAN.md) covers step-by-step setup, how it works, features, limitations and troubleshooting.

A self-hosted MCP server for Figma with the same tools and parameters as the **official Figma MCP server**. It runs on your own machine with your own token.

Each tool name carries a `figma_local_` prefix (`figma_local_get_design_context`, `figma_local_use_figma`, …). That way it can run next to the official Figma MCP or other Figma servers without two tools sharing a name. Prompts and skills written for the official tools still apply: the agent calls the prefixed version. To use the official names unprefixed, set `FIGMA_TOOL_PREFIX` to an empty string.

- **Reads** go through the companion plugin first. When the "Figma MCP Bridge" plugin is open in the requested file, read tools get their data from the Plugin API and use none of your REST API quota. Otherwise they use the [Figma REST API](https://www.figma.com/developers/api) with a personal access token, and Figma desktop doesn't need to be open.
- **Writes** (`use_figma`) always go through the plugin. It runs Plugin API JavaScript in the open file and talks to the server over a local WebSocket.

```
MCP client (Claude Code, Claude Desktop, Cursor…)
        │ stdio
        ▼
   figma-mcp ──── ws://localhost:3850 ◄── "Figma MCP Bridge" plugin in Figma desktop   (reads first, use_figma)
        │
        └──────── HTTPS ────► api.figma.com          (reads when the plugin isn't open in that file)
```

### Plugin-first reads

Figma's REST API is rate-limited per token, and on free plans and view/collab seats the limit for file reads is very low. Once it's used up, Figma can block reads for days (`429 … Retry after 397698s`). Plugin-first reads avoid that:

- **Node data** comes from the plugin's `exportAsync({ format: 'JSON_REST_V1' })`. It returns the same JSON as the REST nodes endpoint, so code generation, metadata and variables behave the same either way.
- **Screenshots, exports, SVGs and image fills** are rendered by the plugin and saved under `FIGMA_ASSET_DIR`. Tools then return a local `file` path where the REST path returns a temporary `url`.
- **`search_design_system`** indexes the file's components, styles and variables (including variables from enabled libraries) inside the plugin.
- **Fallback:** if a plugin read fails for any reason other than "node not found", the tool falls back to REST, and if both fail the error names both causes. Every response reports its `source` (`plugin` or `rest`).
- **Keep the file visible.** Figma desktop pauses rendering for a file in a background tab or a minimized window. Data reads still work, but screenshots and exports wait until the file is visible, so they time out after 25 seconds with a hint and then fall back to REST.
- **Still REST-only:** library usage (`get_libraries`) and dev resources (`get_code_connect_map`). When REST is unavailable, `get_libraries` returns what the plugin can see.

## Tools

Names below are shown without the `figma_local_` prefix.

| Tool | Backend | Notes |
| --- | --- | --- |
| `get_design_context` | plugin → REST | React + Tailwind reference code with `data-node-id` on each element, `var(--token,fallback)` for bound variables, asset consts, components used, styles, code links and a screenshot. Large nodes fall back to metadata unless `forceCode` is set. |
| `get_metadata` | plugin → REST | XML of layer types, names, positions and sizes. Without `nodeId` it lists the pages. When the plugin is running, the current selection is listed first. |
| `get_screenshot` | plugin → REST | PNG capped by `maxDimension`. Returns a local file path (plugin) or a URL plus a curl command (REST); inline base64 only when `enableBase64Response` is set. |
| `get_variable_defs` | plugin → REST | `{name: value}` for the variables and styles used by a node. |
| `get_figjam` | plugin → REST | FigJam content as XML (stickies, shapes, connectors with from/to, sections, text) plus an image. |
| `download_assets` | plugin → REST | `export`, `rawImages` (original fills, with the format detected from the file bytes) and `svgAssets`, as local files (plugin) or URLs (REST). Follows the node's export settings unless you override them. |
| `get_code_connect_map` | plugin → REST, dev resources via REST | Maps component instances to the code links attached to their main components as Dev Mode dev resources. |
| `search_design_system` | plugin → REST | Searches components, styles and variables in the file, plus your team's libraries when `FIGMA_TEAM_ID` is set. |
| `get_libraries` | REST (partial via plugin) | Libraries the file uses, what the file itself publishes, and (with `FIGMA_TEAM_ID`) team libraries you can add, paginated. |
| `use_figma` | plugin | Runs JavaScript with the `figma` global. Single expressions return their value, `console.log` output is captured, nodes come back as `{id, name, type}`, and `exportAsync()` bytes come back as images. Each call is one undo step. |
| `whoami` | REST + plugin | The authenticated user, the auth method, the tool prefix, the bridge mode, and which files have the plugin open (with page and selection). |

`fileKey` also accepts a pasted figma.com URL, and `nodeId` accepts both `1:2` and `1-2`. Branch URLs resolve to the branch key.

### Differences from the official server

The official server uses Figma internals that the public API does not expose, so some behavior is approximated:

- **Code generation** is this project's own React + Tailwind generator. It covers auto layout (flex, wrap, grid), FIXED/HUG/FILL sizing, absolute children with constraints, fills, gradients, image fills, borders, radii, shadows, blurs, blend modes, text styles with per-range overrides, and icons exported as SVG. Expect it to differ from Figma's own output.
- **Variables**: the REST variables endpoint works only on Enterprise plans. On other plans, variable names come from the plugin. Without either one, bound variables are listed as unresolved IDs and raw values are used.
- **Code Connect**: mappings published with the Figma Code Connect CLI are not readable through the public API. This server reads Dev Mode **dev resources** instead, so link your code components there.
- **Libraries**: the API does not say which libraries are switched on for a file. `get_libraries` reports the libraries the file actually uses.
- **Not included**: `create_session`, `create_new_file`, `generate_figma_design`/`html_to_figma`, `upload_assets`, `add_code_connect_map`, `generate_diagram`, Figma Make files, and the official skill resources. Most of what these do can be done through `use_figma`.

## Setup

### 1. Build

```bash
git clone https://github.com/deniahc566/FigmaMCP-LocalBridge.git
```

```bash
cd FigmaMCP-LocalBridge
```

```bash
npm install
```

```bash
npm run build
```

Requires Node.js 20 or newer.

### 2. Create a personal access token

In Figma, go to **Settings → Security → Personal access tokens** and generate a token with these scopes:

| Scope | Used by |
| --- | --- |
| `file_content:read` | everything that reads a file |
| `current_user:read` | `whoami` |
| `file_dev_resources:read` | `get_code_connect_map`, code links in `get_design_context` |
| `library_content:read` | published components and styles of a file |
| `library_assets:read` | resolving library components (`get_libraries`, code links) |
| `team_library_content:read`, `projects:read` | team library search (only with `FIGMA_TEAM_ID`) |
| `file_variables:read` | REST variables (Enterprise only, optional) |

### 3. Register the server with your client

Claude Code:

```bash
claude mcp add figma-local -e FIGMA_ACCESS_TOKEN=figd_your_token -- node /absolute/path/to/figma-mcp/dist/index.js
```

To keep the token out of the client config, copy `.env.example` to `.env`, put the token there, and start the server with Node's `--env-file` flag (Node 20.6+):

```bash
claude mcp add --scope user figma-local -- node --env-file=/absolute/path/to/figma-mcp/.env /absolute/path/to/figma-mcp/dist/index.js
```

Claude Desktop, Cursor and other JSON-configured clients:

```json
{
  "mcpServers": {
    "figma-local": {
      "command": "node",
      "args": ["/absolute/path/to/figma-mcp/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_token",
        "FIGMA_TEAM_ID": "optional-team-id"
      }
    }
  }
}
```

This server can stay connected alongside the official Figma MCP and `figma-mcp-go`: its tools all start with `figma_local_`, so none of the names collide. To send the agent to this server, mention it by name (for example, "use the figma_local tools").

### 4. Install the companion plugin (needed for `use_figma`)

1. Open the Figma **desktop** app.
2. Go to **Plugins → Development → Import plugin from manifest…** and choose `plugin/manifest.json`.
3. In the file you want to edit, run **Plugins → Development → Figma MCP Bridge**. The plugin window shows "Connected to 1 MCP server" once the server is found. Keep the window open while you work.

The plugin connects to every port in `localhost:3850–3854`. Each running server instance (for example, one per Claude Code session) takes the first free port, so several sessions can use the same plugin window.

When all five ports are taken, a new instance joins one of the listening instances as a **relay**: its reads and `use_figma` calls go through that instance's port to the plugin. When the instance it relays through shuts down, the relay takes the freed port, or joins another instance. `whoami` reports the bridge `mode` (`host`, `relay`, or `waiting`) and the `relayPort`. Only instances from this build can relay. An instance from an older build holds its port without answering, so while older sessions hold all five ports, a new instance waits and retries in the background. Restart those sessions to update them.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `FIGMA_ACCESS_TOKEN` | — | Personal access token (sent as `X-Figma-Token`). `FIGMA_API_KEY` also works. |
| `FIGMA_OAUTH_TOKEN` | — | OAuth token (sent as `Bearer`). Used instead of the PAT when both are set. |
| `FIGMA_TEAM_ID` | — | Turns on team library search and the "available to add" list. The team ID is in the team page URL: `figma.com/files/team/<id>/…` |
| `FIGMA_ASSET_DIR` | system temp `/figma-mcp-assets` | Where screenshots and assets rendered by the plugin are saved, one folder per file key. |
| `FIGMA_TOOL_PREFIX` | `figma_local_` | Prepended to every tool name. Set it to an empty string for the official names, or to your own prefix (letters, digits, `_`, `-`). |
| `FIGMA_BRIDGE` | `on` | Set to `off` to disable the plugin bridge. |
| `FIGMA_BRIDGE_HOST` | `127.0.0.1` | Interface the bridge binds to. |
| `FIGMA_BRIDGE_PORTS` | `3850-3854` | Ports to try. If you change them, update `devAllowedDomains` in `plugin/manifest.json` and `PORTS` in `plugin/ui.html` to match. |
| `FIGMA_BRIDGE_SECRET_FILE` | `~/.figma-mcp/bridge-secret` | Shared secret that relaying instances present. It is created on first use. Every instance must use the same file. |
| `FIGMA_BRIDGE_TIMEOUT_MS` | `60000` | Default timeout for `use_figma`. |
| `FIGMA_API_BASE` | `https://api.figma.com` | REST base URL (the tests point it at a mock). |

## Security

- The bridge listens only on loopback. It refuses WebSocket connections that carry a real web origin, so a browser tab cannot pose as the plugin. Figma plugin iframes report the opaque origin `null`.
- A relaying instance must present the secret from `FIGMA_BRIDGE_SECRET_FILE`, which is readable only by your account. Other users on the same machine cannot send code to your plugin through the loopback port.
- `use_figma` runs any code the agent sends, with full edit rights in the open file. Each call is a single undo step, but review what the agent is doing in files that matter.
- The token stays in the server process. The plugin never sees it.

## Development

```bash
npm test
```

The test suite builds the project and then runs:

- `test/codegen.test.mjs`: URL parsing, layout/text/asset/variable code generation, and metadata XML against a fixture card design.
- `test/e2e.test.mjs`: starts the real server over stdio against a mock Figma REST API, and runs the real `plugin/code.js` against a mocked `figma` global, relayed over the bridge WebSocket the same way `plugin/ui.html` does. It checks that reads make no REST file calls while the plugin is open, and that they fall back to REST when the plugin can't read. A second instance on the same port checks the relay: calls through it reach the plugin, a peer without the secret is refused, and the relay takes over the port when the first instance shuts down.
- `test/naming.test.mjs`: the tool-name prefix (default, empty, custom, invalid) and the prefixed names inside descriptions and instructions.

Source layout:

```
src/
  index.ts            stdio entry point, starts the bridge
  server.ts           McpServer + instructions
  config.ts           environment configuration
  figma/reader.ts     plugin-first reads (JSON_REST_V1 export, renders) with REST fallback
  figma/rest.ts       REST client (retries on 429/5xx, short-lived caches)
  figma/variables.ts  variable resolution: plugin → REST (Enterprise) → unresolved
  bridge/server.ts    WebSocket bridge to the plugin, and the relay between instances
  codegen/            React + Tailwind generator, XML metadata, paint helpers
  tools/              tool definitions, grouped by area
plugin/               companion Figma plugin (manifest, main thread, UI relay)
examples/             call-tool.mjs: call a tool from a script, without an agent
```

## License

[MIT](LICENSE)
