import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { errorMessage } from '../util.js';

/**
 * Local WebSocket bridge to the companion Figma plugin (see plugin/).
 *
 * Plugin protocol, one JSON object per message:
 *   plugin -> server  {type:"hello", protocol, fileKey?, fileName, editorType, pageName, user?}
 *   plugin -> server  {type:"context", fileName, pageName, selection:[{id,name,type}]}
 *   server -> plugin  {type:"request", id, method:"execute", params:{code, timeoutMs}}
 *   plugin -> server  {type:"response", id, ok, result?, error?, logs?}
 *
 * The plugin connects to every port in the range, so only as many server instances as there are
 * ports can host it. An instance that finds every port taken joins a hosting instance as a relay
 * peer and sends its requests through it, over the same port:
 *   peer -> host  {type:"peer-hello", protocol, secret}
 *   host -> peer  {type:"peer-welcome", protocol, plugins:[PluginInfo]}
 *   host -> peer  {type:"plugins", plugins:[PluginInfo]}   whenever a plugin connects, leaves or changes page/selection
 *   peer -> host  {type:"execute", id, connectionId, code, timeoutMs}
 *   host -> peer  {type:"executed", id, ok, result?, logs, plugin?, error?}
 * When its host shuts down, a peer takes the freed port or joins another host. The secret comes
 * from a file in the user's home directory, so other accounts on the machine cannot run code in the
 * user's Figma files through the loopback port.
 */

export const BRIDGE_PROTOCOL = 1;

/** host: listens on a port. relay: sends requests through a host. waiting: neither yet; retrying. */
export type BridgeMode = 'host' | 'relay' | 'waiting';

export interface PluginInfo {
  connectionId: string;
  fileKey?: string;
  fileName: string;
  editorType: string;
  pageName?: string;
  user?: { id?: string; name?: string };
  selection: { id: string; name: string; type: string }[];
  connectedAt: string;
}

export interface ExecuteResult {
  result: unknown;
  logs: string[];
  plugin: PluginInfo;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  ws: WebSocket;
  info: PluginInfo;
  pending: Map<string, Pending<{ result: unknown; logs: string[] }>>;
  alive: boolean;
}

interface Relay {
  ws: WebSocket;
  port: number;
  plugins: PluginInfo[];
  pending: Map<string, Pending<ExecuteResult>>;
}

const MAX_PAYLOAD = 64 * 1024 * 1024;
/** How long a listening instance gets to welcome a peer. Builds without relay support never do. */
const JOIN_TIMEOUT_MS = 1_000;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

export class BridgeError extends Error {}

function bridgeError(message: string, logs: string[] = [], stack?: string): BridgeError {
  const err = new BridgeError(message);
  (err as any).logs = logs;
  (err as any).pluginStack = stack;
  return err;
}

function parse(raw: RawData): any {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
}

function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Read the relay secret, creating it (readable by this user only) on first use. */
async function loadSecret(file: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const secret = (await readFile(file, 'utf8')).trim();
      if (secret.length >= 32) return secret;
      // Empty: another instance created the file a moment ago and is still writing it.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const secret = randomBytes(32).toString('hex');
      try {
        await writeFile(file, secret, { mode: 0o600, flag: 'wx' });
        return secret;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${file} does not hold a usable secret; delete it to have a new one created`);
}

export class PluginBridge {
  private wss?: WebSocketServer;
  private httpServers: Server[] = [];
  private connections = new Map<string, Connection>();
  private peers = new Set<WebSocket>();
  private relay?: Relay;
  private secret?: string;
  private heartbeat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private retryDelay = FIRST_RETRY_MS;
  private reportedWaiting = false;
  private stopped = false;
  port?: number;

  constructor(
    private host: string,
    private ports: number[],
    private secretFile?: string,
    private log: (msg: string) => void = () => {},
  ) {}

  /**
   * Listen on the first free port, or join a listening instance as a relay when every port is
   * taken. With neither, keep retrying in the background until a port frees up.
   */
  async start(): Promise<BridgeMode> {
    if (this.secretFile) {
      try {
        this.secret = await loadSecret(this.secretFile);
      } catch (err) {
        this.log(`relaying is off: cannot read or create the bridge secret (${errorMessage(err)})`);
      }
    }
    await this.connect();
    return this.mode;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    if ((await this.listen()) || (await this.join())) {
      this.retryDelay = FIRST_RETRY_MS;
      this.reportedWaiting = false;
      return;
    }
    if (!this.reportedWaiting) {
      this.reportedWaiting = true;
      this.log(
        `plugin bridge waiting: ports ${this.ports.join(', ')} are in use and none accepted this instance as a relay; retrying in the background.`,
      );
    }
    this.scheduleRetry(this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
  }

  private scheduleRetry(delayMs: number) {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect();
    }, delayMs);
    this.retry.unref();
  }

  private async listen(): Promise<boolean> {
    for (const port of this.ports) {
      const servers = await this.tryListen(port);
      if (!servers) continue;
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
      for (const srv of servers) {
        srv.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
      }
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
      this.wss = wss;
      this.httpServers = servers;
      this.port = port;
      this.heartbeat = setInterval(() => this.sweep(), 30_000);
      this.heartbeat.unref();
      const loopback = this.host === '127.0.0.1' || this.host === 'localhost';
      this.log(`plugin bridge listening on ws://${loopback ? `localhost:${port} (127.0.0.1 and ::1)` : `${this.host}:${port}`}`);
      return true;
    }
    return false;
  }

  /**
   * The plugin connects to ws://localhost, which may resolve to ::1 before 127.0.0.1 (it does on
   * Windows), so a loopback host binds both addresses. A port counts as free only if every address
   * we bind is free; a machine without IPv6 just gets the IPv4 listener.
   */
  private async tryListen(port: number): Promise<Server[] | null> {
    const loopback = this.host === '127.0.0.1' || this.host === 'localhost';
    const hosts = loopback ? ['127.0.0.1', '::1'] : [this.host];
    const bound: Server[] = [];
    for (const host of hosts) {
      const srv = createServer((_req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain' });
        res.end('Figma MCP bridge: WebSocket connections only.\n');
      });
      const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        srv.once('listening', () => resolve(null));
        srv.once('error', (err) => resolve(err));
        srv.listen(port, host);
      });
      if (!error) {
        bound.push(srv);
        continue;
      }
      const ipv6Unavailable = host === '::1' && (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT');
      if (ipv6Unavailable && bound.length) continue;
      for (const s of bound) s.close();
      return null;
    }
    return bound;
  }

  /**
   * Ask every port at once and relay through the first instance that welcomes this one, so ports
   * held by builds that never answer cost one JOIN_TIMEOUT_MS in total rather than one each.
   */
  private join(): Promise<boolean> {
    if (!this.secret) return Promise.resolve(false);
    return new Promise((resolve) => {
      let unanswered = this.ports.length;
      for (const port of this.ports) {
        void this.tryJoin(port).then((relay) => {
          if (relay && !this.relay && !this.stopped) {
            this.relay = relay;
            this.log(`plugin bridge ports are all in use; relaying through the instance on port ${port}`);
            resolve(true);
          } else {
            relay?.ws.close();
          }
          if (--unanswered === 0) resolve(false);
        });
      }
    });
  }

  private tryJoin(port: number): Promise<Relay | undefined> {
    const host = this.host === 'localhost' || this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host;
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${host.includes(':') ? `[${host}]` : host}:${port}`, { maxPayload: MAX_PAYLOAD });
      let relay: Relay | undefined;
      const timer = setTimeout(() => ws.terminate(), JOIN_TIMEOUT_MS);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'peer-hello', protocol: BRIDGE_PROTOCOL, secret: this.secret })));
      ws.on('message', (raw) => {
        const msg = parse(raw);
        if (!msg) return;
        if (!relay) {
          if (msg.type !== 'peer-welcome') return;
          clearTimeout(timer);
          relay = { ws, port, plugins: Array.isArray(msg.plugins) ? msg.plugins : [], pending: new Map() };
          resolve(relay);
        } else if (msg.type === 'plugins' && Array.isArray(msg.plugins)) {
          relay.plugins = msg.plugins;
        } else if (msg.type === 'executed') {
          const pending = relay.pending.get(msg.id);
          if (!pending) return;
          relay.pending.delete(msg.id);
          clearTimeout(pending.timer);
          const logs = Array.isArray(msg.logs) ? msg.logs.map(String) : [];
          if (msg.ok) pending.resolve({ result: msg.result, logs, plugin: msg.plugin });
          else pending.reject(bridgeError(msg.error?.message ?? 'Plugin reported an error', logs, msg.error?.stack));
        }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        clearTimeout(timer);
        if (relay) this.onRelayClosed(relay);
        else resolve(undefined);
      });
    });
  }

  private onRelayClosed(relay: Relay) {
    // A second welcome that join() turned down, never used.
    if (this.relay !== relay) return;
    this.relay = undefined;
    for (const p of relay.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('The instance this session relayed through shut down before the plugin replied.'));
    }
    relay.pending.clear();
    if (this.stopped) return;
    this.log(`relay through port ${relay.port} closed; taking over a free port or joining another instance`);
    // Peers of the same host all notice at once; staggering them lets one take the freed port and
    // the rest join it.
    this.scheduleRetry(300 + Math.random() * 1_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.relay?.ws.close();
    for (const peer of this.peers) peer.terminate();
    this.peers.clear();
    for (const conn of this.connections.values()) conn.ws.terminate();
    this.connections.clear();
    this.wss?.close();
    await Promise.all(this.httpServers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    // Figma plugin iframes have an opaque ("null") origin. Refuse real web origins so an open
    // browser tab cannot pose as the plugin and receive the code the agent sends.
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      this.log(`rejected bridge connection from origin ${origin}`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    this.log(`bridge connection from ${req.socket.remoteAddress} (origin ${origin ?? 'none'}); waiting for hello`);
    ws.once('message', (raw) => {
      const first = parse(raw);
      if (first?.type === 'peer-hello') this.acceptPeer(ws, first);
      else this.acceptPlugin(ws, first);
    });
  }

  private acceptPlugin(ws: WebSocket, first: any) {
    const connectionId = randomUUID();
    const conn: Connection = {
      ws,
      pending: new Map(),
      alive: true,
      info: { connectionId, fileName: 'unknown', editorType: 'unknown', selection: [], connectedAt: new Date().toISOString() },
    };
    let greeted = false;

    const handle = (msg: any) => {
      if (!msg) return;
      if (msg.type === 'hello') {
        if (msg.protocol !== BRIDGE_PROTOCOL) {
          ws.close(1002, `protocol ${msg.protocol} unsupported; server speaks ${BRIDGE_PROTOCOL}`);
          return;
        }
        greeted = true;
        conn.info = {
          ...conn.info,
          fileKey: typeof msg.fileKey === 'string' && msg.fileKey ? msg.fileKey : undefined,
          fileName: String(msg.fileName ?? 'unknown'),
          editorType: String(msg.editorType ?? 'unknown'),
          pageName: msg.pageName,
          user: msg.user,
        };
        this.connections.set(connectionId, conn);
        ws.send(JSON.stringify({ type: 'welcome', protocol: BRIDGE_PROTOCOL, connectionId }));
        this.log(`plugin connected: ${conn.info.fileName} (${conn.info.fileKey ?? 'file key unavailable'})`);
        this.announce();
      } else if (msg.type === 'context' && greeted) {
        if (msg.fileName) conn.info.fileName = String(msg.fileName);
        if (msg.pageName) conn.info.pageName = String(msg.pageName);
        if (Array.isArray(msg.selection)) conn.info.selection = msg.selection;
        this.announce();
      } else if (msg.type === 'response') {
        const pending = conn.pending.get(msg.id);
        if (!pending) return;
        conn.pending.delete(msg.id);
        clearTimeout(pending.timer);
        const logs = Array.isArray(msg.logs) ? msg.logs.map(String) : [];
        if (msg.ok) pending.resolve({ result: msg.result, logs });
        else pending.reject(bridgeError(msg.error?.message ?? 'Plugin reported an error', logs, msg.error?.stack));
      }
    };

    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (raw) => handle(parse(raw)));
    ws.on('close', () => {
      this.connections.delete(connectionId);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new BridgeError('The Figma plugin disconnected before replying.'));
      }
      if (greeted) {
        this.log(`plugin disconnected: ${conn.info.fileName}`);
        this.announce();
      }
    });
    handle(first);
  }

  private acceptPeer(ws: WebSocket, hello: any) {
    if (hello.protocol !== BRIDGE_PROTOCOL) {
      ws.close(1002, `protocol ${hello.protocol} unsupported; server speaks ${BRIDGE_PROTOCOL}`);
      return;
    }
    if (!this.secret || !sameSecret(hello.secret, this.secret)) {
      this.log('rejected a relay peer that did not present the bridge secret');
      ws.close(1008, 'bad secret');
      return;
    }
    this.peers.add(ws);
    ws.send(JSON.stringify({ type: 'peer-welcome', protocol: BRIDGE_PROTOCOL, plugins: this.list() }));
    this.log(`relay peer joined (${this.peers.size} relaying through this instance)`);
    ws.on('message', (raw) => {
      const msg = parse(raw);
      if (msg?.type === 'execute') void this.serveExecute(ws, msg);
    });
    ws.on('close', () => {
      if (!this.peers.delete(ws) || this.stopped) return;
      this.log(`relay peer left (${this.peers.size} relaying through this instance)`);
    });
  }

  /** Run a peer's request in the plugin connection it picked from the list this host sent it. */
  private async serveExecute(ws: WebSocket, msg: any) {
    const reply = (body: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'executed', id: msg.id, ...body }));
    };
    const conn = typeof msg.connectionId === 'string' ? this.connections.get(msg.connectionId) : undefined;
    if (!conn) return reply({ ok: false, logs: [], error: { message: 'The Figma plugin disconnected before the request reached it.' } });
    try {
      const { result, logs } = await this.executeIn(conn, String(msg.code ?? ''), Number(msg.timeoutMs) || 60_000);
      reply({ ok: true, result, logs, plugin: conn.info });
    } catch (err) {
      reply({ ok: false, logs: (err as any).logs ?? [], error: { message: errorMessage(err), stack: (err as any).pluginStack } });
    }
  }

  /** Tell relay peers which plugins are connected; they need the list for list() and hasFile(). */
  private announce() {
    if (!this.peers.size) return;
    const msg = JSON.stringify({ type: 'plugins', plugins: this.list() });
    for (const peer of this.peers) if (peer.readyState === WebSocket.OPEN) peer.send(msg);
  }

  private sweep() {
    for (const conn of this.connections.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }

  get mode(): BridgeMode {
    if (this.wss) return 'host';
    if (this.relay) return 'relay';
    return 'waiting';
  }

  get listening(): boolean {
    return Boolean(this.wss);
  }

  /** The port of the instance this one relays through, in relay mode. */
  get relayPort(): number | undefined {
    return this.relay?.port;
  }

  list(): PluginInfo[] {
    if (this.relay) return this.relay.plugins;
    return [...this.connections.values()].map((c) => c.info);
  }

  /** True when a plugin is connected that is known (or, with a single connection, assumed) to be in fileKey. */
  hasFile(fileKey?: string): boolean {
    try {
      this.pick(fileKey);
      return true;
    } catch {
      return false;
    }
  }

  private pick(fileKey?: string): PluginInfo {
    if (this.mode === 'waiting') {
      throw new BridgeError(
        this.secret
          ? `The plugin bridge is not connected: ports ${this.ports.join(', ')} are all in use and none of them accepted this session as a relay (instances from an older figma-mcp build cannot relay). It keeps retrying; restart or close one of the other sessions to free a port.`
          : `The plugin bridge is not listening (ports ${this.ports.join(', ')} are all in use or the bridge is disabled).`,
      );
    }
    const plugins = this.list();
    if (plugins.length === 0) {
      throw new BridgeError(
        'No Figma plugin is connected. In the Figma desktop app, open the file and run Plugins > Development > "Figma MCP Bridge" (import plugin/manifest.json once first).',
      );
    }
    if (fileKey) {
      const exact = plugins.find((p) => p.fileKey === fileKey);
      if (exact) return exact;
      const unknown = plugins.filter((p) => !p.fileKey);
      if (unknown.length === 1 && plugins.length === 1) return unknown[0];
      const open = plugins.map((p) => `"${p.fileName}" (${p.fileKey ?? 'key unknown'})`).join(', ');
      throw new BridgeError(`No connected plugin is running in file ${fileKey}. Plugins are open in: ${open}. Run the plugin in the target file.`);
    }
    if (plugins.length === 1) return plugins[0];
    throw new BridgeError('Several Figma files have the plugin open; pass fileKey to choose one.');
  }

  /** Run JavaScript in the plugin's main thread with the `figma` global in scope. */
  async execute(fileKey: string | undefined, code: string, timeoutMs: number): Promise<ExecuteResult> {
    const plugin = this.pick(fileKey);
    if (this.relay) return this.executeViaRelay(this.relay, plugin, code, timeoutMs);
    const conn = this.connections.get(plugin.connectionId)!;
    return { ...(await this.executeIn(conn, code, timeoutMs)), plugin: conn.info };
  }

  private executeIn(conn: Connection, code: string, timeoutMs: number): Promise<{ result: unknown; logs: string[] }> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new BridgeError(`The plugin did not reply within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs + 2_000);
      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ type: 'request', id, method: 'execute', params: { code, timeoutMs } }));
    });
  }

  private executeViaRelay(relay: Relay, plugin: PluginInfo, code: string, timeoutMs: number): Promise<ExecuteResult> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      // Longer than the host's own timeout, so the host's more specific error arrives first.
      const timer = setTimeout(() => {
        relay.pending.delete(id);
        reject(new BridgeError(`The plugin did not reply within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs + 5_000);
      relay.pending.set(id, { resolve, reject, timer });
      relay.ws.send(JSON.stringify({ type: 'execute', id, connectionId: plugin.connectionId, code, timeoutMs }));
    });
  }
}
