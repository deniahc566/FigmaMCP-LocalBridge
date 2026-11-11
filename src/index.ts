#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PluginBridge } from './bridge/server.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

// stdout carries the MCP protocol, so all diagnostics go to stderr.
const log = (msg: string) => process.stderr.write(`[figma-mcp] ${msg}\n`);

async function main() {
  const config = loadConfig();
  if (!config.accessToken && !config.oauthToken) {
    log('warning: no FIGMA_ACCESS_TOKEN set; read tools will fail until one is configured.');
  }

  let bridge: PluginBridge | null = null;
  if (config.bridgeEnabled) {
    // Logs its own state: listening, relaying through another instance, or waiting for a free port.
    bridge = new PluginBridge(config.bridgeHost, config.bridgePorts, config.bridgeSecretFile, log);
    await bridge.start();
  }

  const server = createServer(config, bridge);
  await server.connect(new StdioServerTransport());

  // stdin closing, SIGTERM and server.close() itself can each trigger this, so only the first call
  // does the work. On Windows, process.exit() while stdin's pipe is still closing trips a libuv
  // assertion, so let the process exit on its own and only force it if a handle lingers.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await bridge?.stop();
    await server.close();
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
