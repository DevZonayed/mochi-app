/* Codex ⇄ Maestro browser bridge.
   Codex can't host an in-process MCP (its native browser is inert under `codex
   exec`), so to give it the SAME native browser as Claude we register a per-run
   stdio MCP that codex launches. That MCP is a thin shim (embedded below, written
   to disk at boot, run via Electron's own node so there's no PATH dependency in a
   packaged app). The shim speaks MCP to codex on stdio and forwards every tool
   call to THIS process over a local unix socket, where the ONE BrowserController
   (the same one Claude uses) actually drives Chrome. So both engines share one
   browser, one per-project session.

   Proven (probe, 2026-06-14): codex reaches a `-c mcp_servers.<name>={…}` server
   and the result round-trips, but ONLY at `-s danger-full-access -c
   approval_policy=never` (its sandbox auto-cancels MCP tool calls otherwise). The
   shim command/args/env are all honoured. runCodex applies those flags only when
   the browser is on (parity with Claude, which already runs bypassPermissions). */

import { app } from 'electron';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync, unlinkSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserController } from './browser.js';
import type { Store } from './store.js';

/** A registered codex run: the project its browser tools target + the screenshot
    Asset ids produced during the run (folded into the transcript afterward). */
interface RunReg { projectId: string | null; shots: string[] }

/** Handle returned to runCodex: the codex `-c` config to add + the shot list. */
export interface BrowserRunRegistration {
  /** The `mcp_servers.maestro_browser={…}` TOML value to pass via `-c`. */
  mcpServerConfig: string;
  /** Asset ids screenshotted during this run (mutated live; read at the end). */
  shots: string[];
  /** Invalidate the run token (call once the codex run finishes). */
  release(): void;
}

const TOOL_NAMES = [
  'browser_navigate', 'browser_snapshot', 'browser_screenshot', 'browser_click',
  'browser_type', 'browser_press', 'browser_scroll', 'browser_upload',
  'browser_select', 'browser_hover', 'browser_wait',
  'browser_evaluate', 'browser_console', 'browser_back', 'browser_forward',
  'browser_reload', 'browser_tabs', 'browser_new_tab', 'browser_select_tab',
] as const;

const txt = (s: string) => ({ content: [{ type: 'text', text: s }] });
const errRes = (s: string) => ({ content: [{ type: 'text', text: s }], isError: true });
const tomlStr = (s: string) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export class BrowserBridge {
  private server?: net.Server;
  private sockDir: string;
  private sockPath: string;
  private shimPath: string;
  private runs = new Map<string, RunReg>();

  constructor(private browser: BrowserController, private store: Store) {
    // Socket lives in a 0700 dir we own (not world-traversable /tmp), so it's never
    // even briefly group/other-connectable; keep the path short (macOS caps unix
    // socket paths ~104 chars) and per-pid to avoid cross-instance clashes.
    this.sockDir = path.join(app.getPath('userData'), 'sock');
    this.sockPath = path.join(this.sockDir, `br-${process.pid}.sock`);
    this.shimPath = path.join(app.getPath('userData'), 'browser-mcp-shim.cjs');
  }

  /** Materialise the shim on disk + start the local socket server. */
  start(): void {
    try { writeFileSync(this.shimPath, SHIM_SRC, 'utf8'); } catch { /* will fail loudly when codex can't find it */ }
    try { mkdirSync(this.sockDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    try { unlinkSync(this.sockPath); } catch { /* no stale socket */ }
    this.server = net.createServer((conn) => this.onConnection(conn));
    this.server.on('error', () => { /* port/path in use — codex runs will report the failure */ });
    try { this.server.listen(this.sockPath, () => { try { chmodSync(this.sockPath, 0o600); } catch { /* best effort */ } }); } catch { /* listen failed */ }
  }

  stop(): void {
    try { this.server?.close(); } catch { /* already closed */ }
    try { unlinkSync(this.sockPath); } catch { /* gone */ }
  }

  /** Register a codex run: returns the `-c mcp_servers` config + a live shot list. */
  register(projectId: string | null): BrowserRunRegistration {
    const token = randomBytes(18).toString('hex');
    const reg: RunReg = { projectId, shots: [] };
    this.runs.set(token, reg);
    // Run the shim via Electron's own node (always present; no PATH dependency).
    // The per-run token goes in the MCP server's ENV (not the shim's argv) so it
    // isn't exposed in the shim's `ps` output; the 0700-dir 0600 socket is the
    // primary boundary.
    const args = `[${tomlStr(this.shimPath)}, ${tomlStr(this.sockPath)}]`;
    const mcpServerConfig =
      `mcp_servers.maestro_browser={ command = ${tomlStr(process.execPath)}, args = ${args}, env = { ELECTRON_RUN_AS_NODE = "1", MAESTRO_BR_TOKEN = ${tomlStr(token)} } }`;
    return { mcpServerConfig, shots: reg.shots, release: () => { this.runs.delete(token); } };
  }

  private onConnection(conn: net.Socket): void {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) void this.handle(conn, line);
      }
    });
    conn.on('error', () => { /* shim went away mid-call */ });
  }

  private async handle(conn: net.Socket, line: string): Promise<void> {
    let msg: { id?: number; token?: string; tool?: string; args?: Record<string, unknown> };
    try { msg = JSON.parse(line); } catch { return; }
    const reply = (payload: Record<string, unknown>) => { try { conn.write(JSON.stringify({ id: msg.id, ...payload }) + '\n'); } catch { /* shim gone */ } };
    const reg = msg.token ? this.runs.get(msg.token) : undefined;
    if (!reg) { reply({ ok: true, result: errRes('browser session is no longer authorised') }); return; }
    try {
      const result = await this.runTool(reg, String(msg.tool ?? ''), msg.args ?? {});
      reply({ ok: true, result });
    } catch (e) {
      reply({ ok: true, result: errRes(e instanceof Error ? e.message : String(e)) });
    }
  }

  /** Map an MCP tool call to the shared BrowserController (codex's projectId comes
      from the trusted registration, never the wire). Screenshots are recorded so
      they can be folded into the codex transcript as inline images afterward. */
  private async runTool(reg: RunReg, tool: string, a: Record<string, unknown>): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const pid = reg.projectId;
    const b = this.browser;
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
    switch (tool) {
      case 'browser_navigate': { const r = await b.navigate(pid, String(a.url ?? '')); return txt(`Opened ${r.url} — "${r.title}"`); }
      case 'browser_snapshot': { const r = await b.snapshot(pid); return txt(`${r.url} — ${r.title}\n\n${r.aria}`); }
      case 'browser_screenshot': { const r = await b.screenshot(pid, { fullPage: !!a.fullPage }); reg.shots.push(r.assetId); return txt(`Captured a screenshot of ${r.url} (shown in the chat).`); }
      case 'browser_click': { const r = await b.click(pid, { selector: s(a.selector), text: s(a.text), nth: n(a.nth) }); return txt(`Clicked. Now at ${r.url} — "${r.title}"`); }
      case 'browser_type': { const r = await b.type(pid, { selector: s(a.selector), text: String(a.text ?? ''), submit: !!a.submit, clear: !!a.clear }); return txt(`Typed${a.submit ? ' and submitted' : ''}. Now at ${r.url}`); }
      case 'browser_press': { await b.press(pid, String(a.keys ?? '')); return txt(`Pressed ${a.keys}.`); }
      case 'browser_scroll': { await b.scroll(pid, { dy: n(a.dy) }); return txt('Scrolled.'); }
      case 'browser_upload': { const r = await b.upload(pid, { paths: Array.isArray(a.paths) ? (a.paths as unknown[]).map(String) : [], selector: s(a.selector), text: s(a.text) }); return txt(`Attached ${r.files} file(s).`); }
      case 'browser_select': { await b.selectOption(pid, { selector: String(a.selector ?? ''), values: Array.isArray(a.values) ? (a.values as unknown[]).map(String) : [] }); return txt('Selected.'); }
      case 'browser_hover': { await b.hover(pid, { selector: s(a.selector), text: s(a.text) }); return txt('Hovered.'); }
      case 'browser_wait': { await b.waitFor(pid, { selector: s(a.selector), text: s(a.text), ms: n(a.ms) }); return txt('Done waiting.'); }
      case 'browser_evaluate': { const r = await b.evaluate(pid, String(a.expression ?? '')); return txt(r.result); }
      case 'browser_console': { const r = await b.console(pid); return txt(r.messages.slice(-40).join('\n') || '(no console output)'); }
      case 'browser_back': { const r = await b.back(pid); return txt(`Back at ${r.url} — "${r.title}"`); }
      case 'browser_forward': { const r = await b.forward(pid); return txt(`Forward at ${r.url} — "${r.title}"`); }
      case 'browser_reload': { const r = await b.reload(pid); return txt(`Reloaded ${r.url}`); }
      case 'browser_tabs': { const r = await b.listTabs(pid); return txt(r.tabs.map(t => `[${t.index}]${t.active ? '*' : ' '} ${t.title} — ${t.url}`).join('\n') || '(no tabs)'); }
      case 'browser_new_tab': { const r = await b.newTab(pid, s(a.url)); return txt(`New tab at ${r.url}`); }
      case 'browser_select_tab': { const r = await b.selectTab(pid, n(a.index) ?? 0); return txt(`Switched to ${r.url} — "${r.title}"`); }
      default: return errRes(`unknown browser tool: ${tool}`);
    }
  }

  /** Collect the screenshot Assets produced by a finished run, shaped for the
      engine to fold into the codex transcript as inline images. */
  collectShots(shots: string[]): { assetId: string; imagePath: string; width?: number; height?: number }[] {
    const out: { assetId: string; imagePath: string; width?: number; height?: number }[] = [];
    const seen = new Set<string>();
    for (const id of shots) {
      if (seen.has(id)) continue; seen.add(id);
      const aset = this.store.getAsset(id);
      if (aset?.localPath) out.push({ assetId: aset.id, imagePath: aset.localPath, width: aset.width, height: aset.height });
    }
    return out;
  }
}

/* ── The embedded stdio MCP shim (plain CommonJS — runs under Electron's node) ──
   Speaks MCP to codex on stdio; forwards each tool call to the bridge over the
   unix socket; returns the bridge's MCP-shaped result verbatim. Kept dependency-
   free and defensive (the socket may drop). */
const SHIM_TOOLS = JSON.stringify([
  { name: 'browser_navigate', description: 'Open a URL in this project\'s real Chrome (a persistent session — logins/cookies carry across the project\'s chats). Returns the final URL + title.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'Read the current page as a structured accessibility snapshot (roles, names, headings, links, fields). Your PRIMARY way to see the page and decide what to click/type.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_screenshot', description: 'Capture a PNG screenshot of the current page (shown inline in the chat). Prefer browser_snapshot for reading content.', inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } } },
  { name: 'browser_click', description: 'Click an element by `selector` (CSS/Playwright, e.g. text=Sign in) or visible `text`. Auto-waits. Returns the page after the click.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, nth: { type: 'number' } } } },
  { name: 'browser_type', description: 'Type into an input/textarea. Target with `selector` (defaults to the first field). `submit` presses Enter; `clear` empties first.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, clear: { type: 'boolean' } }, required: ['text'] } },
  { name: 'browser_press', description: 'Press a key or chord (e.g. "Enter", "Escape", "Control+a").', inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'browser_scroll', description: 'Scroll vertically. Positive dy down, negative up (default 600).', inputSchema: { type: 'object', properties: { dy: { type: 'number' } } } },
  { name: 'browser_upload', description: 'Upload local file(s) to a web form (e.g. a "Photo/video" or "Attach" button). The ONLY way to attach files — do NOT click the upload button with browser_click (that opens an OS dialog you can\'t use). Pass the button text/selector + absolute file paths; files attach with no dialog.', inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, text: { type: 'string' }, selector: { type: 'string' } }, required: ['paths'] } },
  { name: 'browser_select', description: 'Choose option(s) in a <select> dropdown, by value or visible label.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } }, required: ['selector', 'values'] } },
  { name: 'browser_hover', description: 'Hover an element (reveals hover menus / tooltips). Target by selector or visible text.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'browser_wait', description: 'Wait for an element (selector or text) to appear, or a fixed ms delay.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, ms: { type: 'number' } } } },
  { name: 'browser_evaluate', description: 'Run a JS expression in the page and return its value (JSON, truncated).', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'browser_console', description: 'Read recent console messages and page errors (most recent last).', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_back', description: 'Go back in history.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_forward', description: 'Go forward in history.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_reload', description: 'Reload the current page.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_tabs', description: 'List open tabs (index, title, url; * = active).', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_new_tab', description: 'Open a new tab (optionally at a URL) and switch to it.', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'browser_select_tab', description: 'Switch to a tab by index (from browser_tabs).', inputSchema: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] } },
]);

const SHIM_SRC = `'use strict';
// Maestro browser MCP shim — auto-generated; do not edit. Forwards codex's MCP
// tool calls to the Maestro app over a unix socket.
const net = require('net');
const readline = require('readline');
const TOOLS = ${SHIM_TOOLS};
const sockPath = process.argv[2];
const token = process.env.MAESTRO_BR_TOKEN;
let sock = null, rbuf = '', nextId = 1; const pending = new Map();
function connect() {
  sock = net.connect(sockPath);
  sock.on('data', (d) => { rbuf += d.toString(); let nl; while ((nl = rbuf.indexOf('\\n')) >= 0) { const line = rbuf.slice(0, nl); rbuf = rbuf.slice(nl + 1); try { const m = JSON.parse(line); const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } } catch (e) {} } });
  sock.on('error', () => {}); sock.on('close', () => { sock = null; });
}
connect();
function callBridge(tool, args) {
  return new Promise((resolve) => {
    if (!sock) connect();
    const id = nextId++;
    pending.set(id, resolve);
    try { sock.write(JSON.stringify({ id, token, tool, args }) + '\\n'); } catch (e) { pending.delete(id); resolve({ ok: true, result: { content: [{ type: 'text', text: 'browser bridge unavailable' }], isError: true } }); return; }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: true, result: { content: [{ type: 'text', text: 'browser action timed out' }], isError: true } }); } }, 90000);
  });
}
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'maestro_browser', version: '1.0.0' } } });
  else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  else if (method === 'tools/call') {
    const r = await callBridge((params && params.name) || '', (params && params.arguments) || {});
    send({ jsonrpc: '2.0', id, result: (r && r.result) || { content: [{ type: 'text', text: 'no result' }], isError: true } });
  } else if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
});
`;

export { TOOL_NAMES };
