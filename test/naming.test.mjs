import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';

async function toolNames(env) {
  const server = createServer(loadConfig({ FIGMA_BRIDGE: 'off', ...env }), null);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'naming', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  await client.close();
  return { names: tools.map((t) => t.name).sort(), tools, instructions };
}

test('defaults to the figma_local_ prefix', async () => {
  const { names } = await toolNames({});
  assert.ok(names.every((n) => n.startsWith('figma_local_')), names.join(', '));
  assert.equal(names.length, 11);
});

test('an empty prefix restores the official tool names', async () => {
  const { names, tools, instructions } = await toolNames({ FIGMA_TOOL_PREFIX: '' });
  assert.ok(names.includes('get_design_context') && names.includes('use_figma'));
  assert.match(tools.find((t) => t.name === 'whoami').description, /when use_figma cannot find the plugin/);
  assert.doesNotMatch(instructions, /<official name>/);
});

test('a custom prefix is applied to names and cross-references', async () => {
  const { names, tools } = await toolNames({ FIGMA_TOOL_PREFIX: 'acme_' });
  assert.ok(names.includes('acme_search_design_system'));
  assert.match(tools.find((t) => t.name === 'acme_get_libraries').description, /scope acme_search_design_system via includeLibraryKeys/);
});

test('rejects prefixes with characters tool names cannot hold', () => {
  assert.throws(() => loadConfig({ FIGMA_TOOL_PREFIX: 'bad prefix!' }), /FIGMA_TOOL_PREFIX may only contain/);
});
