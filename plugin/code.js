// Main thread of the Figma MCP Bridge plugin.
// The UI iframe owns the WebSocket connections (the main thread has no network access) and relays
// requests here. Each request runs agent-supplied JavaScript with the `figma` global in scope.

const PROTOCOL = 1;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

figma.showUI(__html__, { width: 280, height: 150, title: 'Figma MCP Bridge', themeColors: true });

function safe(read) {
  try {
    return read();
  } catch (e) {
    return undefined;
  }
}

function selectionSummary() {
  return figma.currentPage.selection.slice(0, 50).map((n) => ({ id: n.id, name: n.name, type: n.type }));
}

function hello() {
  const user = safe(() => figma.currentUser);
  return {
    type: 'hello',
    protocol: PROTOCOL,
    // Only private/development plugins can read fileKey; the server copes when it is missing.
    fileKey: safe(() => figma.fileKey),
    fileName: figma.root.name,
    editorType: figma.editorType,
    pageName: figma.currentPage.name,
    user: user ? { id: user.id, name: user.name } : undefined,
  };
}

function context() {
  return { type: 'context', fileName: figma.root.name, pageName: figma.currentPage.name, selection: selectionSummary() };
}

function isNode(v) {
  return typeof v.id === 'string' && typeof v.type === 'string' && 'removed' in v;
}

// Turn plugin API values into plain JSON. Nodes become {id, name, type}; byte arrays become base64
// so the server can return exported images.
function serialize(value, depth, seen) {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return undefined;
  if (value instanceof Uint8Array) {
    return { __type: 'Uint8Array', byteLength: value.byteLength, base64: figma.base64Encode(value) };
  }
  if (seen.has(value)) return '[Circular]';
  if (isNode(value)) {
    return value.removed ? { id: value.id, removed: true } : { id: value.id, name: value.name, type: value.type };
  }
  if (depth > 12) return '[MaxDepth]';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.slice(0, 5000).map((v) => {
      const s = serialize(v, depth + 1, seen);
      return s === undefined ? null : s;
    });
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      const s = serialize(value[key], depth + 1, seen);
      if (s !== undefined) out[key] = s;
    }
  }
  seen.delete(value);
  return out;
}

function formatLogArg(arg) {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(serialize(arg, 0, new Set()));
  } catch (e) {
    return String(arg);
  }
}

// Try the code as a single expression first so `figma.currentPage.name` returns its value,
// then as a function body that uses `return`.
function compile(code) {
  const bodies = ['return (' + code + '\n)', code];
  let lastError;
  for (const body of bodies) {
    try {
      return new AsyncFunction('figma', 'console', body);
    } catch (e) {
      lastError = e;
    }
  }
  // Some sandboxes block the Function constructor but allow indirect eval.
  for (const body of bodies) {
    try {
      return (0, eval)('(async function (figma, console) {\n' + body + '\n})');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function execute(params) {
  const logs = [];
  const capture = (level) => (...args) => {
    logs.push((level === 'log' ? '' : `[${level}] `) + args.map(formatLogArg).join(' '));
    console[level](...args);
  };
  const sandboxConsole = { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error'), debug: capture('debug') };
  const timeoutMs = params.timeoutMs || 60000;
  let timer;
  try {
    const fn = compile(params.code);
    const result = await Promise.race([
      fn(figma, sandboxConsole),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Code timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
    safe(() => figma.commitUndo());
    return { ok: true, result: serialize(result, 0, new Set()), logs };
  } catch (e) {
    return { ok: false, error: { message: e && e.message ? e.message : String(e), stack: e && e.stack }, logs };
  } finally {
    clearTimeout(timer);
  }
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'ready') {
    figma.ui.postMessage({ type: 'hello', payload: hello() });
    figma.ui.postMessage({ type: 'context', payload: context() });
    return;
  }
  if (msg.type === 'request') {
    const req = msg.request;
    let payload;
    if (req.method === 'execute') payload = await execute(req.params || {});
    else payload = { ok: false, error: { message: `Unknown method ${req.method}` } };
    figma.ui.postMessage({ type: 'response', port: msg.port, payload: Object.assign({ type: 'response', id: req.id }, payload) });
  }
};

figma.on('selectionchange', () => figma.ui.postMessage({ type: 'context', payload: context() }));
figma.on('currentpagechange', () => figma.ui.postMessage({ type: 'context', payload: context() }));
