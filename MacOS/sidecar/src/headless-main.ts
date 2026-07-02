// Headless entry for the Maestro brain. Mirrors the construction in the former Electron main.ts
// (the `app.whenReady()` block) MINUS the Electron-window pieces (BrowserWindow, protocol handler,
// relay HostClient, P2P, updater, the windowed ExtensionBridge). It builds the SAME
// `createDispatch(...)` the renderer talks to and serves it over the loopback WS host, so the
// native SwiftUI app gets the full local RPC surface — identical to what `window.maestro.call`
// reached. Brain logic is unchanged; only the transport differs (WS instead of Electron IPC).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app as shimApp } from './electron-shim.ts';
import { startWsHost } from './ws-host.ts';
import { serveDesign } from './design-serve.ts';

import { Store } from '../../brain/store.js';
import { Providers } from '../../brain/providers.js';
import { LocalEngine } from '../../brain/engine.js';
import { BrowserManager } from '../../brain/browser/manager.js';
import { MediaEngine } from '../../brain/media.js';
import { ResearchEngine } from '../../brain/research.js';
import { PublishingEngine } from '../../brain/publishing.js';
import { CodexBridge } from '../../brain/codex-bridge.js';
import { TelegramBot } from '../../brain/telegram.js';
import { WhatsAppClient } from '../../brain/whatsapp.js';
import { GitService } from '../../brain/git-service.js';
import { GitWatcher } from '../../brain/git-watcher.js';
import { CronRunner } from '../../brain/cron.js';
import { makeWhatsappAnalyzer } from '../../brain/whatsapp-analyze.js';
import { createDispatch } from '../../brain/localApi.js';
import { setEnginesRoot } from '../../brain/engines.js';
import { bootstrapNodePath } from '../../brain/node-shim.js';
import { HostClient } from '../../brain/hostClient.js';
import { buildModelGroups, refreshModelGroups } from '../../brain/models.js';
import { isRemoteBlocked } from '../../brain/remote-guard.js';
import type { Asset, Job } from '../../brain/store.js';

// Tell the Swift supervisor we're alive the moment the entry body runs (before the heavy brain
// construction below), so it can distinguish "alive and booting" from "hung/dead". And turn any
// construction failure into a structured {fatal} line instead of a silent exit — the supervisor
// surfaces that reason in the UI instead of a generic "Not connected". (Handlers registered here
// catch synchronous throws in the construction that follows, since they run first.)
process.stdout.write(JSON.stringify({ phase: 'starting' }) + '\n');
process.on('uncaughtException', (e) => {
  try { process.stdout.write(JSON.stringify({ fatal: (e as Error)?.message ?? String(e) }) + '\n'); } catch { /* noop */ }
  process.stderr.write(`[sidecar] uncaughtException: ${(e as Error)?.stack ?? String(e)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  try { process.stdout.write(JSON.stringify({ fatal: (e as Error)?.message ?? String(e) }) + '\n'); } catch { /* noop */ }
  process.stderr.write(`[sidecar] unhandledRejection: ${(e as Error)?.stack ?? String(e)}\n`);
  process.exit(1);
});

const RELAY_URL = (process.env.MAESTRO_SERVER_URL || 'https://api.nexalance.cloud').replace(/\/$/, '');
const ACCOUNT_SESSION_PATH = path.join(shimApp.getPath('userData'), 'account-session.json');

function warn(label: string, e: unknown) {
  process.stderr.write(`[sidecar] ${label}: ${(e as Error)?.message ?? e}\n`);
}

// --- event emitter: broadcast over the WS host (filled in once the host is up) ---
let emitToClients: ((name: string, data: unknown) => void) | null = null;
let accountHost: HostClient | null = null;
let accountSessionToken = '';
const emit = (name: string, data: unknown, _opts?: { live?: boolean; desktopOnly?: boolean }) => {
  emitToClients?.(name, data);
  if (_opts?.live || _opts?.desktopOnly || name.startsWith('wa-')) return;
  const relayData = name === 'asset' && data && typeof data === 'object' ? store.slimAssetForRelay(data as Asset)
    : name === 'job' && data && typeof data === 'object' ? store.slimJobForRelay(data as Job)
    : data;
  accountHost?.event(name, relayData);
  accountHost?.pushSnapshot();
};

// --- construct the brain (essential path must succeed) ---
const store = new Store();
try { store.settleOrphanedRuns(); } catch (e) { warn('settleOrphanedRuns', e); }
const providers = new Providers(store);

// Engine binaries are downloaded into userData/engines; point the brain there + fix `node` on PATH.
try {
  const raw = process.env.MAESTRO_ENGINES_DIR;
  const enginesDir = raw
    ? (raw.startsWith('~/') || raw === '~' ? path.join(os.homedir(), raw.slice(1)) : path.resolve(raw))
    : path.join(shimApp.getPath('userData'), 'engines');
  setEnginesRoot(enginesDir);
  bootstrapNodePath(enginesDir);
} catch (e) { warn('engines/node-path setup', e); }

const engine = new LocalEngine(store, emit, providers);
const media = new MediaEngine(store, emit, () => providers.getLocalKey('fal'));
const research = new ResearchEngine(store, engine, emit);
const publishing = new PublishingEngine(store, emit);
try { engine.setPublishing(publishing); } catch (e) { warn('setPublishing', e); }

// Image generation: wire the SAME closure as main.ts so the in-process "maestro" MCP exposes the
// `generate_image` tool to the agent (without this, the agent reports "image generation offline" —
// the tool is gated on `imageGen` being set). Codex-first (free native image_gen, edits via `-i`),
// fal FLUX fallback (schnell for fresh, kontext for edits).
try {
  engine.setImageGen(async (prompt, opts) => {
    const editing = !!(opts.sourceImagePath || opts.sourceImageUrl);
    const codexCanEdit = !editing || !!(opts.sourceImagePath && existsSync(opts.sourceImagePath));
    const codexReady = store.routing().image === 'codex' && engine.status('codex').available;
    if (codexReady && codexCanEdit) {
      try {
        return await engine.imageViaCodex(prompt, { aspect: opts.aspect, projectId: opts.projectId, sourceImagePath: opts.sourceImagePath });
      } catch (e) {
        const falReady = providers.list().some(c => c.provider === 'fal');
        if (!falReady) throw e; // no fal to fall back to — surface codex's error
      }
    }
    const asset = editing
      ? await media.generateAndWait({ modelKey: 'flux-kontext', prompt, projectId: opts.projectId ?? null, imageUrl: opts.sourceImageUrl, imagePath: opts.sourceImagePath, aspect: opts.aspect })
      : await media.generateAndWait({ modelKey: 'flux-schnell', prompt, projectId: opts.projectId ?? null, aspect: opts.aspect });
    if (!asset.localPath) throw new Error(`image was ${editing ? 'edited' : 'generated'} but saving it locally failed — please try again`);
    return { path: asset.localPath, assetId: asset.id, alt: prompt.slice(0, 200), width: asset.width, height: asset.height };
  });
} catch (e) { warn('setImageGen', e); }

// Codex parity bridge (best-effort — needs the codex binary, which may not be downloaded yet).
let codexBridge: CodexBridge | null = null;
try {
  codexBridge = new CodexBridge(store);
  codexBridge.start();
  engine.setCodexBridge(codexBridge);
  codexBridge.setBg({
    start: (o) => engine.bgStart(o),
    output: (id, tailKB) => engine.bgOutput(id, tailKB),
    list: (pid) => engine.bgList(pid),
    stop: (id) => engine.bgStop(id),
  });
} catch (e) { warn('codexBridge', e); }

const telegram = new TelegramBot(store, engine, providers, emit);
const whatsapp = new WhatsAppClient(store, emit);
try { engine.setComms(whatsapp); } catch (e) { warn('setComms', e); }

const gitService = new GitService(store, emit, providers);
try { engine.setGitService(gitService); } catch (e) { warn('setGitService', e); }
const gitWatcher = new GitWatcher(store, gitService);

// Cron runner: fires scheduled messages + recurring jobs + due publishes, and backs the agent's
// `schedule_*` MCP tools (gated on `engine.setCron`). Without this, the operator's Schedule queue
// would never fire. Started in boot() once the WS host is up so fired events reach the client.
const cron = new CronRunner(store, engine, emit, (nowMs) => publishing.fireDue(nowMs),
  makeWhatsappAnalyzer({ store, engine, client: whatsapp, emit }));
try { engine.setCron(cron); } catch (e) { warn('setCron', e); }

// Playwright-backed browser for the native app: one persistent context per project,
// driving the user's INSTALLED Chrome (channel:'chrome', nothing bundled). Replaces
// the old extension control channel on the native path. The agent reaches it via
// engine.setBrowserManager; the Swift app reaches it via the browser* RPCs below.
const browserManager = new BrowserManager({
  userDataDir: shimApp.getPath('userData'),
  settings: () => store.getSettings().browser ?? { enabled: true, headless: false },
  dispatch: (m, p) => dispatch(m, p),
  emit: (s) => emit('browser', s),
});
try { engine.setBrowserManager(browserManager); } catch (e) { warn('setBrowserManager', e); }

// The full local dispatch — identical to what the renderer reached over Electron IPC.
// getExtensionBridge → null (the native app uses Playwright, not the Chrome extension).
const dispatch = createDispatch(
  store, engine, media, research, publishing, telegram, whatsapp, providers,
  emit, RELAY_URL, gitService, () => null, gitWatcher, browserManager,
);

function isJob(x: unknown): x is Job {
  return !!x && typeof x === 'object' && 'input' in x && 'status' in x && 'phase' in x && 'projectId' in x;
}

async function handleRemoteCommand(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (isRemoteBlocked(method)) throw Object.assign(new Error('not available remotely'), { statusCode: 403 });
  if (method === 'submitFeedback') params = { ...params, source: (params as { source?: unknown }).source === 'phone' ? 'phone' : 'web' };
  const r = await dispatch(method, params);
  if (isJob(r)) return store.slimJobForRelay(r);
  if (Array.isArray(r)) return r.map((x) => (isJob(x) ? store.slimJobForRelay(x) : x));
  if (r && typeof r === 'object' && isJob((r as { job?: unknown }).job)) return { ...r, job: store.slimJobForRelay((r as { job: Job }).job) };
  return r;
}

function getSnapshot() {
  return { ...store.snapshot(providers.list()), engineStatus: engine.statuses(), mediaRates: media.rates(), models: buildModelGroups(engine.statuses()) };
}

function readAccountToken(): string {
  try {
    const raw = JSON.parse(readFileSync(ACCOUNT_SESSION_PATH, 'utf8')) as { token?: unknown };
    return typeof raw.token === 'string' ? raw.token.trim() : '';
  } catch { return ''; }
}

function writeAccountToken(token: string): void {
  mkdirSync(path.dirname(ACCOUNT_SESSION_PATH), { recursive: true });
  writeFileSync(ACCOUNT_SESSION_PATH, JSON.stringify({ token, updatedAt: Date.now() }), { mode: 0o600 });
}

function clearAccountToken(): void {
  try { unlinkSync(ACCOUNT_SESSION_PATH); } catch { /* no persisted session */ }
}

function startAccountHost(token: string): void {
  const t = token.trim();
  if (!t) return;
  accountSessionToken = t;
  if (accountHost) { accountHost.updateSession(t); return; }
  accountHost = new HostClient({
    url: RELAY_URL,
    sessionToken: t,
    deviceId: store.deck.deckId,
    name: os.hostname(),
    deckId: store.deck.deckId,
    getSnapshot,
    onCommand: (method, params) => handleRemoteCommand(method, params),
  });
  accountHost.start();
  void refreshModelGroups(providers, { force: true }).then(() => accountHost?.pushSnapshot()).catch(() => {});
}

function stopAccountHost(): void {
  accountSessionToken = '';
  if (accountHost) { accountHost.stop(); accountHost = null; }
}

async function authPost(pathname: string, body: Record<string, unknown>, token?: string): Promise<{ token: string; body: unknown; status: number }> {
  const res = await fetch(`${RELAY_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* empty response */ }
  if (!res.ok) {
    const msg = (parsed as { message?: string; error?: string } | null)?.message
      ?? (parsed as { error?: string } | null)?.error
      ?? `request failed (${res.status})`;
    throw Object.assign(new Error(msg), { statusCode: res.status });
  }
  const header = res.headers.get('set-auth-token')?.trim() ?? '';
  const bodyToken = (parsed as { token?: unknown } | null)?.token;
  return { token: header || (typeof bodyToken === 'string' ? bodyToken.trim() : ''), body: parsed, status: res.status };
}

async function accountDevices(): Promise<unknown[]> {
  if (!accountSessionToken) return [];
  const res = await fetch(`${RELAY_URL}/api/devices`, { headers: { authorization: `Bearer ${accountSessionToken}` } });
  if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'session expired' : `devices failed (${res.status})`), { statusCode: res.status });
  return await res.json() as unknown[];
}

async function handleAccountCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'accountStatus': {
      let devices: unknown[] = [];
      try { devices = await accountDevices(); } catch { /* status can still render signed-in */ }
      return { signedIn: !!accountSessionToken, deviceId: store.deck.deckId, serverUrl: RELAY_URL, devices };
    }
    case 'accountDevices':
      return await accountDevices();
    case 'accountSignIn': {
      const email = String(params.email ?? '').trim();
      const password = String(params.password ?? '');
      if (!email || !password) throw Object.assign(new Error('email and password required'), { statusCode: 400 });
      const r = await authPost('/api/auth/sign-in/email', { email, password });
      if (!r.token) throw Object.assign(new Error('signed in but no session token was returned'), { statusCode: 500 });
      writeAccountToken(r.token);
      startAccountHost(r.token);
      return { signedIn: true, deviceId: store.deck.deckId, serverUrl: RELAY_URL, devices: await accountDevices().catch(() => []) };
    }
    case 'accountSignUp': {
      const name = String(params.name ?? '').trim() || 'Maestro User';
      const email = String(params.email ?? '').trim();
      const password = String(params.password ?? '');
      if (!email || !password) throw Object.assign(new Error('email and password required'), { statusCode: 400 });
      const r = await authPost('/api/auth/sign-up/email', { name, email, password });
      if (!r.token) throw Object.assign(new Error('account created but no session token was returned'), { statusCode: 500 });
      writeAccountToken(r.token);
      startAccountHost(r.token);
      return { signedIn: true, deviceId: store.deck.deckId, serverUrl: RELAY_URL, devices: await accountDevices().catch(() => []) };
    }
    case 'accountSignOut':
      if (accountSessionToken) await authPost('/api/auth/sign-out', {}, accountSessionToken).catch(() => ({ token: '', body: null, status: 0 }));
      stopAccountHost();
      clearAccountToken();
      return { signedIn: false, deviceId: store.deck.deckId, serverUrl: RELAY_URL, devices: [] };
    case 'accountSetSession': {
      const token = typeof params.token === 'string' ? params.token.trim() : '';
      if (!token) {
        stopAccountHost();
        clearAccountToken();
        return { signedIn: false, deviceId: store.deck.deckId, serverUrl: RELAY_URL, devices: [] };
      }
      writeAccountToken(token);
      startAccountHost(token);
      return { signedIn: true, deviceId: store.deck.deckId, serverUrl: RELAY_URL, devices: await accountDevices().catch(() => []) };
    }
    default:
      return undefined;
  }
}

const WEB_ROOT = process.env.MAESTRO_WEB_ROOT ? path.resolve(process.env.MAESTRO_WEB_ROOT) : '';

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

async function serveWebApp(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/app' && !url.pathname.startsWith('/app/')) return false;
  if (!WEB_ROOT) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('web bundle not configured');
    return true;
  }

  let rel = decodeURIComponent(url.pathname.replace(/^\/app\/?/, '')) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const target = path.resolve(WEB_ROOT, rel);
  const relToRoot = path.relative(WEB_ROOT, target);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return true;
  }

  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': contentTypeFor(target),
      'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(await fsp.readFile(target));
    }
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
  return true;
}

// HTTP handler for the WebKit app bundle and design live-preview routes.
const httpHandler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean> => {
  const url = req.url ?? '';
  if (await serveWebApp(req, res)) return true;
  const m = url.match(/^\/design\/([^/]+)(\/.*)?$/);
  if (!m) return false;
  const projectId = decodeURIComponent(m[1]);
  const rel = (m[2] ?? '/design/index.html').replace(/\?.*$/, '');
  const r = await serveDesign(store, projectId, rel);
  res.writeHead(r.status, { 'content-type': r.contentType, ...(r.headers ?? {}) });
  res.end(r.body);
  return true;
};

// Boot is wrapped (no top-level await) so the esbuild ESM bundle stays unambiguous for Node.
async function boot() {
  const host = await startWsHost(async (method, params) => {
    if (method.startsWith('account')) return await handleAccountCall(method, params);
    return await dispatch(method, params);
  }, httpHandler);
  emitToClients = host.emit;

  process.stdout.write(JSON.stringify({ ready: true, port: host.port, token: host.token }) + '\n');
  process.stderr.write(`[sidecar] full dispatch live on 127.0.0.1:${host.port}\n`);

  // Best-effort boot resumes (run AFTER the host is up so their events have somewhere to go).
  try { cron.start(); } catch (e) { warn('cron.start', e); }
  try { media.resumeOnBoot(); } catch (e) { warn('media.resumeOnBoot', e); }
  try { telegram.resumeOnBoot(); } catch (e) { warn('telegram.resumeOnBoot', e); }
  try { whatsapp.resumeOnBoot(); } catch (e) { warn('whatsapp.resumeOnBoot', e); }
  const persistedToken = readAccountToken();
  if (persistedToken) {
    try { startAccountHost(persistedToken); } catch (e) { warn('account host', e); }
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      try { stopAccountHost(); } catch { /* noop */ }
      try { cron.stop(); } catch { /* noop */ }
      try { gitWatcher.detachAll(); } catch { /* noop */ }
      try { void browserManager.shutdown(); } catch { /* noop */ }
      try { host.close(); } catch { /* noop */ }
      process.exit(0);
    });
  }
}

void boot();
