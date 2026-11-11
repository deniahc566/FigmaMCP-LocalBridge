// End-to-end: the real server over stdio, a mock Figma REST API, and the real plugin/code.js
// running against a mocked `figma` global, relayed over the bridge WebSocket like plugin/ui.html does.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const FILE_KEY = 'TESTFILEKEY1234567890ab';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const BRIDGE_PORT = 38900 + Math.floor(Math.random() * 90);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/card.json', import.meta.url), 'utf8'));
const entry = fixture.nodes['1:2'];
const root = fileURLToPath(new URL('..', import.meta.url));
const assetDir = path.join(os.tmpdir(), `figma-mcp-e2e-${process.pid}`);
const secretDir = path.join(os.tmpdir(), `figma-mcp-e2e-secret-${process.pid}`);

let api;
let apiBase;
let client;
/** A second server instance that finds the bridge port taken and relays through the first. */
let relay;
let plugin;

/** Paths the mock REST API has served, so tests can assert which reads skipped REST. */
const requests = [];
const fileReads = () => requests.filter((p) => p.startsWith(`/v1/files/${FILE_KEY}`) || p.startsWith(`/v1/images/${FILE_KEY}`)).filter((p) => !p.endsWith('/dev_resources'));

function startApi() {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname;
    requests.push(p);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (p.startsWith('/cdn/')) {
      if (p.endsWith('.jpg')) return send(200, JPEG, 'image/jpeg');
      if (p.endsWith('.svg')) return send(200, '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml');
      return send(200, PNG, 'image/png');
    }
    if (req.headers['x-figma-token'] !== 'test-token') return send(403, { status: 403, err: 'Invalid token' });
    if (p === '/v1/me') return send(200, { id: 'u1', email: 'dev@example.com', handle: 'Dev', img_url: '' });
    if (p === `/v1/files/${FILE_KEY}/nodes`) {
      const nodes = {};
      for (const id of url.searchParams.get('ids').split(',')) nodes[id] = fixture.nodes[id] ?? null;
      return send(200, { ...fixture, nodes });
    }
    if (p === `/v1/files/${FILE_KEY}`) {
      return send(200, {
        name: 'Shop UI',
        lastModified: fixture.lastModified,
        editorType: 'figma',
        document: {
          id: '0:0',
          name: 'Document',
          type: 'DOCUMENT',
          children: [
            { id: '0:1', name: 'Page 1', type: 'CANVAS', children: [entry.document] },
            { id: '5:0', name: 'Components', type: 'CANVAS', children: [] },
          ],
        },
        components: entry.components,
        componentSets: entry.componentSets,
        styles: entry.styles,
      });
    }
    if (p === `/v1/images/${FILE_KEY}`) {
      const fmt = url.searchParams.get('format') ?? 'png';
      const images = {};
      for (const id of url.searchParams.get('ids').split(',')) images[id] = `${apiBase}/cdn/${encodeURIComponent(id)}.${fmt}`;
      return send(200, { err: null, images });
    }
    if (p === `/v1/files/${FILE_KEY}/images`) return send(200, { error: false, status: 200, meta: { images: { abc123: `${apiBase}/cdn/photo.jpg` } } });
    if (p === `/v1/files/${FILE_KEY}/variables/local`) return send(403, { status: 403, err: 'Limited to Enterprise plans' });
    if (p === `/v1/files/${FILE_KEY}/dev_resources`) {
      return send(200, { dev_resources: [{ id: 'd1', name: 'Button.tsx', url: 'https://github.com/acme/ui/Button.tsx', file_key: FILE_KEY, node_id: '10:0' }] });
    }
    const published = p.match(/^\/v1\/files\/[^/]+\/(components|component_sets|styles)$/);
    if (published) return send(200, { meta: { [published[1]]: [] } });
    send(404, { status: 404, err: `no mock for ${p}` });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

/** Run plugin/code.js with a mocked figma global and relay it to the bridge like ui.html. */
async function startFakePlugin() {
  const src = readFileSync(new URL('../plugin/code.js', import.meta.url), 'utf8');
  let toUi = () => {};
  const vars = {
    'VariableID:1:5': { name: 'Surface/Default', resolvedType: 'COLOR', value: { r: 1, g: 1, b: 1, a: 1 } },
    'VariableID:1:6': { name: 'Spacing/4', resolvedType: 'FLOAT', value: 16 },
  };
  const variable = (id) =>
    vars[id] && {
      id,
      key: `key-${id}`,
      name: vars[id].name,
      resolvedType: vars[id].resolvedType,
      variableCollectionId: 'c1',
      valuesByMode: { m1: vars[id].value },
      codeSyntax: {},
      resolveForConsumer() {
        return { value: vars[id].value, resolvedType: vars[id].resolvedType };
      },
    };
  // Nodes behave like the Plugin API: unknown IDs resolve to null, and JSON_REST_V1 exports return
  // the same JSON as the REST nodes endpoint.
  const find = (id, n = entry.document) => (n.id === id ? n : (n.children ?? []).reduce((hit, c) => hit ?? find(id, c), null));
  const nodeProxy = (raw) => ({
    id: raw.id,
    name: raw.name,
    type: raw.type,
    removed: false,
    absoluteBoundingBox: raw.absoluteBoundingBox,
    absoluteRenderBounds: raw.absoluteRenderBounds ?? raw.absoluteBoundingBox,
    async exportAsync(opts = {}) {
      if (opts.format === 'JSON_REST_V1') {
        if (figma.failExports) throw new Error('export failed');
        return { document: structuredClone(raw), components: entry.components, componentSets: entry.componentSets, styles: entry.styles, schemaVersion: 0 };
      }
      if (opts.format === 'SVG') return new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
      return new Uint8Array(PNG);
    },
  });
  const figma = {
    failExports: false,
    showUI() {},
    ui: { postMessage: (m) => toUi(m), onmessage: null },
    on() {},
    root: {
      name: 'Shop UI',
      children: [
        { id: '0:1', name: 'Page 1', type: 'PAGE' },
        { id: '5:0', name: 'Components', type: 'PAGE' },
      ],
      findAllWithCriteria: () => [
        { id: '10:0', key: 'setkey', name: 'Button', type: 'COMPONENT_SET', description: 'Primary action button', children: [{}], parent: { type: 'PAGE', name: 'Components' } },
      ],
    },
    editorType: 'figma',
    fileKey: FILE_KEY,
    currentUser: { id: 'u1', name: 'Dev' },
    currentPage: { name: 'Page 1', selection: [{ id: '1:2', name: 'Product Card', type: 'FRAME', removed: false }] },
    base64Encode: (u8) => Buffer.from(u8).toString('base64'),
    commitUndo() {},
    loadAllPagesAsync: async () => {},
    getNodeByIdAsync: async (id) => {
      const raw = find(id);
      return raw ? nodeProxy(raw) : null;
    },
    getImageByHash: (hash) => (hash === 'abc123' ? { getBytesAsync: async () => new Uint8Array(JPEG) } : null),
    getLocalPaintStylesAsync: async () => [],
    getLocalTextStylesAsync: async () => [{ id: 'S:title', key: 'k1', name: 'Heading/H3', description: '' }],
    getLocalEffectStylesAsync: async () => [{ id: 'S:shadow', key: 'k2', name: 'Elevation/Card', description: '' }],
    getLocalGridStylesAsync: async () => [],
    createRectangle: () => ({ id: '99:1', name: 'Rectangle', type: 'RECTANGLE', removed: false }),
    variables: {
      getVariableByIdAsync: async (id) => variable(id) ?? null,
      getVariableCollectionByIdAsync: async () => ({ id: 'c1', name: 'Tokens', defaultModeId: 'm1' }),
      getLocalVariableCollectionsAsync: async () => [{ id: 'c1', name: 'Tokens' }],
      getLocalVariablesAsync: async () => Object.keys(vars).map(variable),
    },
    teamLibrary: { getAvailableLibraryVariableCollectionsAsync: async () => [], getVariablesInLibraryCollectionAsync: async () => [] },
  };
  new Function('figma', '__html__', src)(figma, '');

  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
  await once(ws, 'open');
  toUi = (m) => ws.send(JSON.stringify(m.payload));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'request') figma.ui.onmessage({ type: 'request', port: BRIDGE_PORT, request: msg });
  });
  const welcome = once(ws, 'message');
  figma.ui.onmessage({ type: 'ready' });
  assert.equal(JSON.parse((await welcome)[0].toString()).type, 'welcome');
  return { ws, figma };
}

// The server prefixes every tool by default so it never collides with the official Figma MCP.
const P = 'figma_local_';
const call = (name, args = {}) => client.callTool({ name: P + name, arguments: args });
const texts = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text);

/** Start a server instance over stdio. Every instance gets the same bridge port and secret. */
async function startClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: root,
    env: {
      ...process.env,
      FIGMA_ACCESS_TOKEN: 'test-token',
      FIGMA_API_BASE: apiBase,
      FIGMA_BRIDGE_PORTS: String(BRIDGE_PORT),
      FIGMA_BRIDGE_SECRET_FILE: path.join(secretDir, 'bridge-secret'),
      FIGMA_ASSET_DIR: assetDir,
    },
    stderr: 'pipe',
  });
  const c = new Client({ name: 'e2e', version: '1.0.0' });
  await c.connect(transport);
  return c;
}

before(async () => {
  api = await startApi();
  apiBase = `http://127.0.0.1:${api.address().port}`;
  client = await startClient();
});

after(async () => {
  plugin?.ws.close();
  await client?.close();
  await relay?.close();
  api?.close();
  rmSync(assetDir, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
});

test('exposes the official tools under the figma_local_ prefix', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    [
      'download_assets',
      'get_code_connect_map',
      'get_design_context',
      'get_figjam',
      'get_libraries',
      'get_metadata',
      'get_screenshot',
      'get_variable_defs',
      'search_design_system',
      'use_figma',
      'whoami',
    ].map((n) => P + n),
  );
  const ctx = tools.find((t) => t.name === `${P}get_design_context`);
  assert.deepEqual(ctx.inputSchema.required.sort(), ['fileKey', 'nodeId']);
  // Cross-references in descriptions point at the prefixed names too.
  const meta = tools.find((t) => t.name === `${P}get_metadata`);
  assert.match(meta.description, /Always prefer figma_local_get_design_context\./);
  assert.doesNotMatch(meta.description, /(?<!figma_local_)get_design_context/);
  assert.match(client.getInstructions(), /figma_local_use_figma: run Plugin API JavaScript/);
});

test('whoami reports the user and an idle bridge', async () => {
  const info = JSON.parse(texts(await call('whoami'))[0]);
  assert.equal(info.user.handle, 'Dev');
  assert.equal(info.auth.method, 'personal-access-token');
  assert.equal(info.bridge.mode, 'host');
  assert.equal(info.bridge.listening, true);
  assert.equal(info.bridge.port, BRIDGE_PORT);
  assert.deepEqual(info.bridge.plugins, []);
});

test('get_metadata lists pages without a nodeId and accepts a pasted URL', async () => {
  const [xml] = texts(await call('get_metadata', { fileKey: FILE_KEY }));
  assert.match(xml, /<canvas id="0:1" name="Page 1" \/>/);
  const [nodeXml] = texts(await call('get_metadata', { fileKey: `https://www.figma.com/design/${FILE_KEY}/Shop?node-id=1-2` }));
  assert.match(nodeXml, /^<frame id="1:2" name="Product Card"/);
});

test('get_design_context returns code, context and a screenshot', async () => {
  const res = await call('get_design_context', { fileKey: FILE_KEY, nodeId: '1-2', clientFrameworks: 'react', clientLanguages: 'typescript' });
  assert.ok(!res.isError, texts(res).join('\n'));
  const [code, notes] = texts(res);
  assert.match(code, /export default function ProductCard/);
  assert.ok(code.includes(`const imgPhoto = "${apiBase}/cdn/photo.jpg";`), code);
  assert.ok(code.includes(`const imgIconCart = "${apiBase}/cdn/I1%3A7%3B10%3A2.svg";`), code);
  const context = JSON.parse(notes.slice(notes.indexOf('{')));
  assert.equal(context.componentInstances[0].component, 'Button / Variant=Primary');
  assert.equal(context.componentInstances[0].codeConnect.codeConnectSrc, 'https://github.com/acme/ui/Button.tsx');
  assert.equal(context.styles['Heading/H3'], 'Font(family: "Inter", style: Semi Bold, size: 20, weight: 600, lineHeight: 28, letterSpacing: 0)');
  assert.deepEqual(context.unresolvedVariableIds.sort(), ['VariableID:1:5', 'VariableID:1:6']);
  const img = res.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.equal(img.data, PNG.toString('base64'));
});

test('get_screenshot scales to maxDimension and returns a URL', async () => {
  const res = await call('get_screenshot', { fileKey: FILE_KEY, nodeId: '1:2' });
  const meta = JSON.parse(texts(res)[0]);
  assert.equal(meta.original_width, 336);
  assert.equal(meta.original_height, 436);
  assert.equal(meta.height, 1024);
  assert.equal(meta.width, 789);
  assert.match(texts(res)[1], /curl -L -o figma-1-2\.png/);
  assert.ok(!res.content.some((c) => c.type === 'image'));
});

test('download_assets reports export, raw images with real format, and svgs', async () => {
  const out = JSON.parse(texts(await call('download_assets', { fileKey: FILE_KEY, nodeId: '1:2' }))[0]);
  assert.equal(out.export.format, 'png');
  assert.equal(out.export.scale, 1);
  assert.deepEqual(out.rawImages.map((r) => [r.imageRef, r.format]), [['abc123', 'jpeg']]);
  assert.deepEqual(out.svgAssets.map((s) => s.nodeId), ['I1:7;10:2']);
});

test('get_variable_defs without the plugin returns styles and flags unnamed variables', async () => {
  const res = await call('get_variable_defs', { fileKey: FILE_KEY, nodeId: '1:2' });
  const defs = JSON.parse(texts(res)[0]);
  assert.ok(defs['Heading/H3'].startsWith('Font('));
  assert.ok(defs['Elevation/Card'].startsWith('Effect(type: DROP_SHADOW'));
  assert.match(texts(res)[1], /2 bound variable\(s\) could not be named/);
});

test('use_figma explains how to connect when no plugin is running', async () => {
  const res = await call('use_figma', { fileKey: FILE_KEY, code: 'figma.root.name', description: 'read name' });
  assert.equal(res.isError, true);
  assert.match(texts(res)[0], /No Figma plugin is connected/);
});

test('the bridge rejects connections from web origins', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`, { headers: { Origin: 'https://evil.example' } });
  const [code] = await once(ws, 'close');
  assert.equal(code, 1008);
});

test('the bridge also accepts the IPv6 loopback that "localhost" may resolve to', async (t) => {
  const ws = new WebSocket(`ws://[::1]:${BRIDGE_PORT}`);
  const outcome = await Promise.race([once(ws, 'open').then(() => 'open'), once(ws, 'error').then(([e]) => e.code)]);
  if (outcome === 'EADDRNOTAVAIL' || outcome === 'EAFNOSUPPORT') return t.skip('no IPv6 on this machine');
  assert.equal(outcome, 'open');
  ws.close();
});

test('the plugin connects and shows up in whoami', async () => {
  plugin = await startFakePlugin();
  const info = JSON.parse(texts(await call('whoami'))[0]);
  assert.equal(info.bridge.plugins.length, 1);
  assert.equal(info.bridge.plugins[0].fileKey, FILE_KEY);
  assert.equal(info.bridge.plugins[0].fileName, 'Shop UI');
});

test('get_metadata prepends the plugin selection', async () => {
  const [xml] = texts(await call('get_metadata', { fileKey: FILE_KEY }));
  assert.match(xml, /^Currently selected nodes:\n- 1:2 Product Card \(FRAME\)/);
});

test('with the plugin open, reads go through it and make no REST file calls', async () => {
  requests.length = 0;
  const ctx = await call('get_design_context', { fileKey: FILE_KEY, nodeId: '1:2' });
  assert.ok(!ctx.isError, texts(ctx).join('\n'));
  const [code, notes] = texts(ctx);
  const photo = code.match(/const imgPhoto = "([^"]+)";/)[1];
  assert.ok(photo.endsWith('.jpg') && existsSync(photo), photo);
  const icon = code.match(/const imgIconCart = "([^"]+)";/)[1];
  assert.ok(icon.endsWith('.svg') && existsSync(icon), icon);
  assert.equal(JSON.parse(notes.slice(notes.indexOf('{'))).source, 'plugin');
  assert.match(notes, /no REST API quota was used/);
  assert.equal(ctx.content.find((c) => c.type === 'image').data, PNG.toString('base64'));

  const shot = await call('get_screenshot', { fileKey: FILE_KEY, nodeId: '1:2' });
  const meta = JSON.parse(texts(shot)[0]);
  assert.equal(meta.source, 'plugin');
  assert.deepEqual([meta.original_width, meta.original_height, meta.width, meta.height], [336, 436, 789, 1024]);
  assert.ok(existsSync(meta.file), meta.file);
  assert.match(texts(shot)[1], /Rendered by the Figma plugin and saved to/);

  const assets = JSON.parse(texts(await call('download_assets', { fileKey: FILE_KEY, nodeId: '1:2' }))[0]);
  assert.equal(assets.source, 'plugin');
  assert.ok(existsSync(assets.export.file));
  assert.deepEqual(assets.rawImages.map((r) => [r.imageRef, r.format]), [['abc123', 'jpeg']]);
  assert.ok(existsSync(assets.rawImages[0].file));
  assert.ok(existsSync(assets.svgAssets[0].file));

  const [xml] = texts(await call('get_metadata', { fileKey: FILE_KEY, nodeId: '1:2' }));
  assert.match(xml, /<frame id="1:2" name="Product Card"/);
  const defs = JSON.parse(texts(await call('get_variable_defs', { fileKey: FILE_KEY, nodeId: '1:2' }))[0]);
  assert.equal(defs['Heading/H3'].startsWith('Font('), true);

  assert.deepEqual(fileReads(), [], 'no REST file, node or image reads while the plugin is open');
});

test('falls back to REST when the plugin cannot read a node', async () => {
  plugin.figma.failExports = true;
  try {
    const res = await call('get_metadata', { fileKey: FILE_KEY, nodeId: '1:2' });
    assert.ok(!res.isError, texts(res).join('\n'));
    assert.match(texts(res)[0], /<frame id="1:2" name="Product Card"/);
  } finally {
    plugin.figma.failExports = false;
  }
});

test('variables resolve through the plugin', async () => {
  const defs = JSON.parse(texts(await call('get_variable_defs', { fileKey: FILE_KEY, nodeId: '1:2' }))[0]);
  assert.equal(defs['Surface/Default'], '#ffffff');
  assert.equal(defs['Spacing/4'], '16');
  const [code] = texts(await call('get_design_context', { fileKey: FILE_KEY, nodeId: '1:2', excludeScreenshot: true }));
  assert.ok(code.includes('bg-[color:var(--surface-default,#ffffff)]'), code);
  assert.ok(code.includes('gap-[var(--spacing-4,16px)]'), code);
});

test('use_figma returns expression values', async () => {
  const res = await call('use_figma', { fileKey: FILE_KEY, code: 'figma.currentPage.name', description: 'page name' });
  assert.ok(!res.isError, texts(res).join('\n'));
  assert.equal(texts(res)[0], '"Page 1"');
});

test('use_figma runs bodies, captures logs, serializes nodes and returns exports as images', async () => {
  const code = `
    const rect = figma.createRectangle();
    console.log('made', rect.id);
    const node = await figma.getNodeByIdAsync('1:2');
    return { rect, png: await node.exportAsync({ format: 'PNG' }) };`;
  const res = await call('use_figma', { fileKey: FILE_KEY, code, description: 'create and export' });
  assert.ok(!res.isError, texts(res).join('\n'));
  const body = JSON.parse(texts(res)[0]);
  assert.deepEqual(body.rect, { id: '99:1', name: 'Rectangle', type: 'RECTANGLE' });
  assert.equal(body.png.format, 'png');
  assert.equal(texts(res)[1], 'console:\nmade 99:1');
  assert.equal(res.content.find((c) => c.type === 'image').data, PNG.toString('base64'));
});

test('use_figma surfaces plugin errors with console output', async () => {
  const res = await call('use_figma', { fileKey: FILE_KEY, code: "console.warn('about to fail'); throw new Error('boom');", description: 'fail' });
  assert.equal(res.isError, true);
  assert.match(texts(res)[0], /^Error: boom/);
  assert.match(texts(res)[0], /\[warn\] about to fail/);
});

test('use_figma refuses a file the plugin is not open in', async () => {
  const res = await call('use_figma', { fileKey: 'OTHERFILEKEY1234567890ab', code: '1', description: 'wrong file' });
  assert.equal(res.isError, true);
  assert.match(texts(res)[0], /No connected plugin is running in file OTHERFILEKEY/);
});

test('search_design_system finds components, styles and plugin variables', async () => {
  const res = await call('search_design_system', {
    fileKey: FILE_KEY,
    queries: [
      { entity: 'component', query: 'button' },
      { entity: 'style', query: 'heading' },
      { entity: 'variable', query: 'surface' },
    ],
  });
  const { results } = JSON.parse(texts(res)[0]);
  assert.equal(results[0].matches[0].name, 'Button');
  assert.equal(results[0].matches[0].type, 'COMPONENT_SET');
  assert.equal(results[0].matches[0].variants, 1);
  assert.equal(results[1].matches[0].name, 'Heading/H3');
  assert.equal(results[2].matches[0].name, 'Surface/Default');
});

test('get_code_connect_map maps instances to dev resource links', async () => {
  const map = JSON.parse(texts(await call('get_code_connect_map', { fileKey: FILE_KEY, nodeId: '1:2' }))[0]);
  assert.deepEqual(map['1:7'], { codeConnectSrc: 'https://github.com/acme/ui/Button.tsx', codeConnectName: 'Button.tsx', component: 'Variant=Primary' });
});

test('get_libraries degrades gracefully when library lookups fail', async () => {
  const res = await call('get_libraries', { fileKey: FILE_KEY });
  assert.ok(!res.isError, texts(res).join('\n'));
  const out = JSON.parse(texts(res)[0]);
  assert.deepEqual(out.libraries_in_use, []);
  assert.ok(out.notes.some((n) => n.includes('FIGMA_TEAM_ID')));
});

test('get_figjam refuses design files', async () => {
  const res = await call('get_figjam', { fileKey: FILE_KEY, nodeId: '1:2' });
  assert.equal(res.isError, true);
  assert.match(texts(res)[0], /not a FigJam board/);
});

test('REST errors come back as readable tool errors', async () => {
  const res = await call('get_design_context', { fileKey: FILE_KEY, nodeId: '404:404' });
  assert.equal(res.isError, true);
  assert.match(texts(res)[0], /Node 404:404 was not found/);
});

const callRelay = (name, args = {}) => relay.callTool({ name: P + name, arguments: args });

test('an instance that finds every port taken relays through the listening one', async () => {
  relay = await startClient();
  const info = JSON.parse(texts(await callRelay('whoami'))[0]);
  assert.equal(info.bridge.mode, 'relay');
  assert.equal(info.bridge.listening, false);
  assert.equal(info.bridge.relayPort, BRIDGE_PORT);
  assert.equal(info.bridge.plugins.length, 1);
  assert.equal(info.bridge.plugins[0].fileKey, FILE_KEY);

  const res = await callRelay('use_figma', { fileKey: FILE_KEY, code: 'figma.currentPage.name', description: 'page name' });
  assert.ok(!res.isError, texts(res).join('\n'));
  assert.equal(texts(res)[0], '"Page 1"');
  assert.match(texts(res)[1], /Ran in "Shop UI", page "Page 1"/);

  const failed = await callRelay('use_figma', { fileKey: FILE_KEY, code: "console.warn('about to fail'); throw new Error('boom');", description: 'fail' });
  assert.equal(failed.isError, true);
  assert.match(texts(failed)[0], /^Error: boom/);
  assert.match(texts(failed)[0], /\[warn\] about to fail/);

  requests.length = 0;
  const [xml] = texts(await callRelay('get_metadata', { fileKey: FILE_KEY, nodeId: '1:2' }));
  assert.match(xml, /<frame id="1:2" name="Product Card"/);
  assert.deepEqual(fileReads(), [], 'relayed reads go through the plugin, not REST');
});

test('the listening instance refuses relay peers without the secret', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'peer-hello', protocol: 1, secret: 'not-the-secret' }));
  const [code] = await once(ws, 'close');
  assert.equal(code, 1008);
});

test('the relay takes over the port when the listening instance shuts down', async () => {
  plugin.ws.close();
  await client.close();
  client = undefined;
  let info;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    info = JSON.parse(texts(await callRelay('whoami'))[0]);
    if (info.bridge.mode === 'host') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(info.bridge.mode, 'host');
  assert.equal(info.bridge.port, BRIDGE_PORT);

  // The real plugin rescans its ports every few seconds; the fake one reconnects explicitly.
  plugin = await startFakePlugin();
  const res = await callRelay('use_figma', { fileKey: FILE_KEY, code: 'figma.currentPage.name', description: 'page name' });
  assert.ok(!res.isError, texts(res).join('\n'));
  assert.equal(texts(res)[0], '"Page 1"');
});
