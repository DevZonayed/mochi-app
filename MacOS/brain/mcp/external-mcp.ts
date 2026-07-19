// Mochi External MCP — the OUTWARD-facing MCP server.
//
// Exposes the app's entire `dispatch(method, params)` surface (see ./manifest.ts) to an
// OUTSIDE agent — Claude Desktop, Cursor, Codex, Cline, or any MCP client — over two
// transports that share ONE gated protocol core:
//
//   • stdio  — the external agent spawns `node mochi-mcp-stdio.cjs`; that thin shim proxies
//              JSON-RPC over stdin/stdout to the loopback HTTP endpoint below.
//   • HTTP   — a loopback (127.0.0.1) Streamable-HTTP MCP endpoint at POST /mcp, Bearer-token
//              gated. URL-style MCP clients connect here directly.
//
// SECURITY MODEL
//   - The HTTP server binds 127.0.0.1 ONLY (never a routable interface).
//   - Every request must present the app-issued token (Authorization: Bearer <token>,
//     x-maestro-mcp-token header, or ?token= query). The token is a store-level secret,
//     never placed in relayed snapshots, and can be rotated from Settings.
//   - Two gates on BOTH tools/list and tools/call: (a) the tool's category must be enabled;
//     (b) DESTRUCTIVE tools (delete/shell/write/outward-send/auth) are hidden and refused
//     unless the operator turned on "Allow destructive actions".
//   - `enabled: false` tears the HTTP server down entirely — no listener, no surface.
//
// This is transport-agnostic at its core: handleJsonRpc() is pure and unit-tested; the HTTP
// wrapper and the stdio shim are thin.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  MCP_CATEGORIES, MCP_TOOLS, MCP_TOOL_BY_METHOD, categoryCounts, toMcpTool,
  type McpToolDef,
} from './manifest.js';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_PORT = 9235;

/** The PREFERRED External MCP port for this channel. The Swift launcher injects
    MAESTRO_MCP_PORT per channel (production 9235 / preview 9236 / development
    9237); we honor a STRICT valid integer port and reject anything malformed
    (including '', '0', negatives, floats, out-of-range) → DEFAULT_PORT. This only
    sets the DEFAULT preferred port; enabling External MCP is still opt-in, and an
    explicitly-configured store port always wins (see normalizeSettings). */
export function preferredMcpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAESTRO_MCP_PORT;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return DEFAULT_PORT; // reject '', '-1', '12.5', ' 9236', 'abc'
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;  // reject '0', '70000'
}

export type Dispatch = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface ExternalMcpSettings {
  /** Master switch. When false, no HTTP server runs and no tools are reachable. */
  enabled: boolean;
  /** Preferred loopback port for the HTTP endpoint (falls back to ephemeral if taken). */
  port: number;
  /** Expose DESTRUCTIVE tools (deletes, shell, writes, outward sends, auth changes). */
  allowDestructive: boolean;
  /** Per-category on/off (keyed by McpCategoryId). Missing key ⇒ the category's manifest default. */
  categories: Record<string, boolean>;
}

export function defaultExternalMcpSettings(): ExternalMcpSettings {
  const categories: Record<string, boolean> = {};
  for (const c of MCP_CATEGORIES) categories[c.id] = c.defaultOn;
  // `enabled:false` stays the fresh-store default on EVERY channel — the env only
  // controls the PREFERRED port, never auto-enables the surface.
  return { enabled: false, port: preferredMcpPort(), allowDestructive: false, categories };
}

/** Merge stored (possibly partial) settings over defaults. */
export function normalizeSettings(raw: Partial<ExternalMcpSettings> | undefined): ExternalMcpSettings {
  const base = defaultExternalMcpSettings();
  if (!raw) return base;
  const categories = { ...base.categories, ...(raw.categories ?? {}) };
  // Port resolution (strict — NO Number() coercion, which would turn the
  // malformed legacy values null / '' / false all into 0):
  //   - a STRICT numeric 0 is the "let the OS pick an ephemeral loopback port"
  //     sentinel (startHttp maps 0 → listen(0)); preserve it,
  //   - a valid integer in 1..65535 is kept,
  //   - anything else (undefined / null / '' / false / NaN / non-integer /
  //     out-of-range) falls back to the default port.
  const rp = raw.port as unknown;
  const port = rp === 0
    ? 0
    : (typeof rp === 'number' && Number.isInteger(rp) && rp > 0 && rp < 65536) ? rp : base.port;
  return {
    enabled: !!raw.enabled,
    port,
    allowDestructive: !!raw.allowDestructive,
    categories,
  };
}

export interface JsonRpcRequest { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
export interface JsonRpcResponse { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

/** Deps the store must satisfy (kept minimal so the handler is unit-testable). */
export interface ExternalMcpStore {
  mcpAccess(): Partial<ExternalMcpSettings> | undefined;
  setMcpAccess(patch: Partial<ExternalMcpSettings>): ExternalMcpSettings;
  mcpToken(): string;
  rotateMcpToken(): string;
}

/** Is a tool reachable under the given settings? */
export function toolAllowed(def: McpToolDef, s: ExternalMcpSettings): boolean {
  if (def.destructive && !s.allowDestructive) return false;
  const cat = s.categories[def.category];
  const dflt = MCP_CATEGORIES.find((c) => c.id === def.category)?.defaultOn ?? true;
  return cat === undefined ? dflt : cat;
}

/** The tools/list payload under the given settings. */
export function listTools(s: ExternalMcpSettings) {
  if (!s.enabled) return [];
  return MCP_TOOLS.filter((t) => toolAllowed(t, s)).map(toMcpTool);
}

const asText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

export interface HandleCtx { dispatch: Dispatch; settings: ExternalMcpSettings }

/** Pure JSON-RPC handler. Returns a response, or null for notifications (no id). */
export async function handleJsonRpc(msg: JsonRpcRequest, ctx: HandleCtx): Promise<JsonRpcResponse | null> {
  const { dispatch, settings } = ctx;
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: (msg.params?.protocolVersion as string) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mochi', version: '1.0.0' },
        instructions: 'Mochi operator control surface. Every tool maps to one Mochi action. '
          + 'Call tools/list for the enabled set; destructive actions may be hidden by the operator.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification — no reply
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: listTools(settings) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const def = MCP_TOOL_BY_METHOD.get(name);
      if (!def) return isNotification ? null : ok(toolError(`Unknown tool: ${name}`));
      if (!toolAllowed(def, settings)) {
        const why = def.destructive
          ? `Tool "${name}" is a destructive action and is disabled. Enable "Allow destructive actions" in Mochi → Settings → External MCP.`
          : `Tool "${name}" belongs to the "${def.category}" category, which is disabled in Mochi → Settings → External MCP.`;
        return ok(toolError(why));
      }
      try {
        const result = await dispatch(def.method, args);
        return ok({ content: [{ type: 'text', text: asText(result) }], structuredContent: wrapStructured(result) });
      } catch (e) {
        const err = e as { message?: string };
        return ok(toolError(`Mochi action "${name}" failed: ${err?.message ?? 'error'}`, publicMcpError(e)));
      }
    }
    default:
      if (isNotification) return null;
      return fail(-32601, `Method not found: ${msg.method ?? '(none)'}`);
  }
}

function toolError(text: string, structuredContent?: Record<string, unknown>) {
  return structuredContent
    ? { content: [{ type: 'text', text }], structuredContent, isError: true }
    : { content: [{ type: 'text', text }], isError: true };
}
/** MCP structuredContent must be an object; wrap primitives/arrays. */
function wrapStructured(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return { result: v };
}

const PUBLIC_MCP_CODE_RE = /^WA_[A-Z0-9_]{1,48}$/;
const PUBLIC_MCP_MESSAGES = new Set([
  'WhatsApp is not linked',
  'WhatsApp is already linked; use reconnect',
  'WhatsApp unlink is in progress',
  'WhatsApp link timed out',
  'WhatsApp link cancelled: paused',
  'WhatsApp link cancelled: unlinked',
  'WhatsApp link cancelled: reconnect',
  'WhatsApp link cancelled: replaced',
  'WhatsApp link cancelled: stale',
]);

function publicMcpError(e: unknown): Record<string, unknown> | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const err = e as { mcpPublic?: unknown; code?: unknown; statusCode?: unknown; message?: unknown };
  if (err.mcpPublic !== true) return undefined;
  if (typeof err.code !== 'string' || !PUBLIC_MCP_CODE_RE.test(err.code)) return undefined;
  if (!Number.isInteger(err.statusCode) || (err.statusCode as number) < 400 || (err.statusCode as number) > 499) return undefined;
  if (typeof err.message !== 'string' || !PUBLIC_MCP_MESSAGES.has(err.message)) return undefined;
  return { error: { code: err.code, statusCode: err.statusCode, message: err.message } };
}

/* ────────────────────────────── HTTP + stdio transports ────────────────────────────── */

export interface ExternalMcpConfig {
  enabled: boolean;
  running: boolean;
  port: number;
  requestedPort: number;
  token: string;
  allowDestructive: boolean;
  toolCount: number;
  categories: (ReturnType<typeof categoryCounts>[number] & { enabled: boolean })[];
  endpoints: {
    httpUrl: string;
    stdioCommand: string;
    stdioArgs: string[];
    stdioEnv: Record<string, string>;
  };
  /** Ready-to-paste config for an external MCP client (Claude Desktop / Cursor / Codex). */
  clientJson: { stdio: unknown; http: unknown };
  warnings: string[];
}

export interface ExternalMcpOpts {
  store: ExternalMcpStore;
  dispatch: Dispatch;
  /** Absolute path to write the stdio shim to (e.g. userData/mochi-mcp-stdio.cjs). */
  shimPath: string;
  /** node/electron-as-node executable the external client should spawn. */
  nodePath: string;
  warn?: (label: string, e: unknown) => void;
}

export class ExternalMcp {
  private server: Server | null = null;
  private boundPort = 0;
  private warnings: string[] = [];
  constructor(private opts: ExternalMcpOpts) {}

  private settings(): ExternalMcpSettings { return normalizeSettings(this.opts.store.mcpAccess()); }

  /** Write the stdio shim to disk (idempotent) and apply the current settings. */
  start(): void {
    try { writeFileSync(this.opts.shimPath, STDIO_SHIM_SRC, 'utf8'); } catch (e) { this.opts.warn?.('mcp shim write', e); }
    this.apply();
  }

  /** (Re)start or stop the HTTP server to match settings. Call after any settings change. */
  apply(): void {
    const s = this.settings();
    if (!s.enabled) { this.stopHttp(); return; }
    // If already listening on the desired port, nothing to do.
    if (this.server && this.boundPort && (this.boundPort === s.port || !s.port)) return;
    this.stopHttp();
    this.startHttp(s.port);
  }

  private startHttp(preferredPort: number): void {
    this.warnings = [];
    const server = createServer((req, res) => { void this.onHttp(req, res); });
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && this.server === server && this.boundPort === 0) {
        // Preferred port taken → fall back to an ephemeral loopback port.
        this.warnings.push(`Port ${preferredPort} was busy — using ${'an automatic port'}; re-copy the config below.`);
        try { server.listen(0, '127.0.0.1'); } catch (err) { this.opts.warn?.('mcp http ephemeral listen', err); }
        return;
      }
      this.opts.warn?.('mcp http server', e);
    });
    server.on('listening', () => {
      const addr = server.address();
      this.boundPort = typeof addr === 'object' && addr ? addr.port : 0;
    });
    this.server = server;
    this.boundPort = 0;
    try { server.listen(preferredPort || 0, '127.0.0.1'); } catch (e) { this.opts.warn?.('mcp http listen', e); }
  }

  private stopHttp(): void {
    const srv = this.server;
    this.server = null;
    this.boundPort = 0;
    if (srv) { try { srv.close(); } catch { /* already closed */ } }
  }

  stop(): void { this.stopHttp(); }

  private authOk(req: IncomingMessage): boolean {
    const token = this.opts.store.mcpToken();
    if (!token) return false;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.replace(/^Bearer\s+/i, '').trim() === token) return true;
    const hdr = req.headers['x-maestro-mcp-token'];
    if (typeof hdr === 'string' && hdr.trim() === token) return true;
    try {
      const q = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('token');
      if (q && q === token) return true;
    } catch { /* bad url */ }
    return false;
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // CORS preflight (some MCP clients run in a webview).
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders()); res.end(); return;
    }
    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    if (!this.settings().enabled) { res.writeHead(503, jsonHeaders()); res.end('{"error":"disabled"}'); return; }
    if (!this.authOk(req)) { res.writeHead(401, jsonHeaders()); res.end('{"error":"unauthorized"}'); return; }
    // GET /mcp opens a server→client SSE stream in Streamable HTTP; we don't push
    // server-initiated messages, so acknowledge with an empty, open-then-idle stream.
    if (req.method === 'GET') {
      res.writeHead(200, { ...corsHeaders(), 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': mochi-mcp stream open\n\n');
      return; // kept open; client closes it
    }
    if (req.method !== 'POST') { res.writeHead(405, jsonHeaders()); res.end('{"error":"method not allowed"}'); return; }

    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { void this.respond(body, res); });
    req.on('error', () => { try { res.writeHead(400, jsonHeaders()); res.end('{"error":"bad request"}'); } catch { /* noop */ } });
  }

  private async respond(body: string, res: ServerResponse): Promise<void> {
    const settings = this.settings();
    let parsed: unknown;
    try { parsed = JSON.parse(body || '{}'); } catch {
      res.writeHead(400, jsonHeaders()); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); return;
    }
    const ctx: HandleCtx = { dispatch: this.opts.dispatch, settings };
    if (Array.isArray(parsed)) {
      const out: JsonRpcResponse[] = [];
      for (const m of parsed) { const r = await handleJsonRpc(m as JsonRpcRequest, ctx); if (r) out.push(r); }
      res.writeHead(200, jsonHeaders()); res.end(JSON.stringify(out)); return;
    }
    const r = await handleJsonRpc(parsed as JsonRpcRequest, ctx);
    if (!r) { res.writeHead(202, jsonHeaders()); res.end(); return; } // notification
    res.writeHead(200, jsonHeaders()); res.end(JSON.stringify(r));
  }

  /** The full config payload for the Settings UI. */
  config(): ExternalMcpConfig {
    const s = this.settings();
    const token = this.opts.store.mcpToken();
    const port = this.boundPort || s.port;
    const httpUrl = `http://127.0.0.1:${port}/mcp`;
    const stdioEnv = { MOCHI_MCP_URL: httpUrl, MOCHI_MCP_TOKEN: token };
    const stdioArgs = [this.opts.shimPath];
    const counts = categoryCounts().map((c) => ({
      ...c,
      enabled: s.categories[c.id] === undefined ? c.defaultOn : !!s.categories[c.id],
    }));
    const toolCount = listTools(s).length;
    const clientJson = {
      stdio: { mcpServers: { mochi: { command: this.opts.nodePath, args: stdioArgs, env: { ELECTRON_RUN_AS_NODE: '1', ...stdioEnv } } } },
      http: { mcpServers: { mochi: { type: 'http', url: httpUrl, headers: { Authorization: `Bearer ${token}` } } } },
    };
    return {
      enabled: s.enabled,
      running: !!this.server,
      port,
      requestedPort: s.port,
      token,
      allowDestructive: s.allowDestructive,
      toolCount,
      categories: counts,
      endpoints: { httpUrl, stdioCommand: this.opts.nodePath, stdioArgs, stdioEnv },
      clientJson,
      warnings: [...this.warnings],
    };
  }
}

function jsonHeaders() { return { ...corsHeaders(), 'content-type': 'application/json; charset=utf-8' }; }
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-maestro-mcp-token, mcp-session-id, mcp-protocol-version',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-expose-headers': 'mcp-session-id',
  };
}

/* ── The stdio shim (plain CommonJS; runs under node or Electron-as-node) ──
   The external agent spawns this. It reads MCP JSON-RPC on stdin, forwards each
   line to the loopback HTTP /mcp endpoint (token from env), and writes the reply
   to stdout. Dependency-free; defensive against the app being offline. */
export const STDIO_SHIM_SRC = `'use strict';
// Mochi MCP stdio shim — auto-generated; do not edit. Proxies an external MCP
// client (Claude Desktop / Cursor / Codex / Cline) to Mochi's loopback HTTP endpoint.
const http = require('http');
const readline = require('readline');
const url = process.env.MOCHI_MCP_URL || 'http://127.0.0.1:${DEFAULT_PORT}/mcp';
const token = process.env.MOCHI_MCP_TOKEN || '';
const target = new URL(url);
function post(payload) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'authorization': 'Bearer ' + token, 'accept': 'application/json' },
    }, (res) => {
      let b = ''; res.on('data', (d) => b += d); res.on('end', () => {
        if (res.statusCode === 202 || !b) { resolve(null); return; }
        try { resolve(JSON.parse(b)); } catch (e) { resolve({ jsonrpc: '2.0', id: payload && payload.id, error: { code: -32603, message: 'bad response from Mochi' } }); }
      });
    });
    req.on('error', (e) => { resolve(payload && payload.id !== undefined && payload.id !== null ? { jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'Mochi is not reachable — is the app running and External MCP enabled? (' + e.message + ')' } } : null); });
    req.write(data); req.end();
  });
}
const send = (m) => { if (m) process.stdout.write(JSON.stringify(m) + '\\n'); };
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  send(await post(msg));
});
rl.on('close', () => process.exit(0));
`;
