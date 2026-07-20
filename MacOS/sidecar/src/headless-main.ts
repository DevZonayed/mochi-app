// Headless entry for the Maestro brain. Mirrors the construction in the former Electron main.ts
// (the `app.whenReady()` block) MINUS the Electron-window pieces (BrowserWindow, protocol handler,
// relay HostClient, P2P, updater, the windowed ExtensionBridge). It builds the SAME
// `createDispatch(...)` the renderer talks to and serves it over the loopback WS host, so the
// native SwiftUI app gets the full local RPC surface — identical to what `window.maestro.call`
// reached. Brain logic is unchanged; only the transport differs (WS instead of Electron IPC).

import { mkdirSync, readFileSync, unlinkSync, writeFileSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app as shimApp, safeStorage } from './electron-shim.ts';
import { startWsHost } from './ws-host.ts';
import { serveDesign } from './design-serve.ts';
import { makeFilePreviewHttp } from './file-preview-http.ts';

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
import { MemorySync } from '../../brain/memory-sync.js';
import { CronRunner } from '../../brain/cron.js';
import { makeWhatsappAnalyzer } from '../../brain/whatsapp-analyze.js';
import { contextIntake, makeOperatorReplyHandler } from '../../brain/context-operator.js';
import { createDispatch, type ExternalMcpControl } from '../../brain/localApi.js';
import { ExternalMcp } from '../../brain/mcp/external-mcp.js';
import { setEnginesRoot } from '../../brain/engines.js';
import { bootstrapNodePath } from '../../brain/node-shim.js';
import { HostClient } from '../../brain/hostClient.js';
import { ShadowHostEnrollmentRuntime } from '../../brain/shadow-enrollment-host.js';
import { ShadowProductProjection } from '../../brain/shadow-product-projection.js';
import { ShadowActionReceiptStore } from '../../brain/shadow-action-receipt.js';
import { buildControllerActionRegistryEntries } from '../../brain/shadow-controller-actions.js';
import { SafeStorageVault, FileHostEnrollmentPersistence } from '../../brain/shadow-host-adapters.js';
import { createShadowHostDispatch } from '../../brain/shadow-host-dispatch.js';
import { screenShareRegistry } from '../../brain/shadow-screen-registry.js';
import { ScreenHostOwner } from '../../brain/shadow-screen-host-owner.js';
import { ScreenRelayHostLink } from '../../brain/shadow-screen-relay-link.js';
import { nodeShadowCrypto as screenBackend } from '@maestro/realtime/shadowCryptoNode';
import type { ScreenSourcePolicy, ScreenAuthoritySnapshot } from '@maestro/realtime/shadowScreenStream';
import { ShadowHostDataService, defineShadowCommandRegistry, type HostCommandExecutor, type ShadowCommandRegistry } from '../../brain/shadow-host-service.js';
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
// M-A: the operator-confirmed screen-sharing display, persisted HOST-LOCAL (never synced;
// the remote can't read or set it). Revalidated against the live source list on boot/report.
const SCREEN_SOURCE_PATH = path.join(shimApp.getPath('userData'), 'screen-source.json');

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
const media = new MediaEngine(store, emit, () => providers.getLocalKey('fal'), () => providers.keyState('fal'));
const research = new ResearchEngine(store, engine, emit);
const publishing = new PublishingEngine(store, emit);
try { engine.setPublishing(publishing); } catch (e) { warn('setPublishing', e); }

// Image generation: wire the SAME closure as main.ts so the in-process "maestro" MCP exposes the
// `generate_image` tool to the agent (without this, the agent reports "image generation offline" —
// the tool is gated on `imageGen` being set). When Image routing is Codex the native built-in
// image_gen tool is the ONLY backend and fails CLOSED to Codex (never FAL, never the OpenAI Images
// API); the fal FLUX media backend (schnell fresh / kontext edit) serves ONLY when routing is Claude.
try {
  engine.setImageGen(async (prompt, opts) => {
    // Image routing = Codex → NATIVE Codex image_gen ONLY, and FAIL CLOSED to Codex.
    // A Codex-selected generate_image call must NEVER silently fall back to any other
    // backend — not FAL/media.generateAndWait, and not the OpenAI Images API. Masking a
    // `codex-no-image` with a non-native result would violate the standing requirement
    // ("Codex native image_gen only"). imageViaCodex runs the built-in image_gen tool on
    // the ChatGPT sign-in (NO API key) and throws actionable Codex errors (sign-in /
    // no-image) that are surfaced VERBATIM.
    if (store.routing().image === 'codex') {
      return await engine.imageViaCodex(prompt, { aspect: opts.aspect, projectId: opts.projectId, sourceImagePath: opts.sourceImagePath });
    }
    // Image routing = Claude → the FAL media backend (schnell for fresh, kontext for edits).
    const editing = !!(opts.sourceImagePath || opts.sourceImageUrl);
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
// Context (knowledge/operator) projects: shared deps for the operator pipeline —
// WA-quiet intake (triage→operator turn) + quoted-reply routing back into the
// operator session. See brain/context-operator.ts.
const contextOps = { store, engine, emit };
const whatsapp = new WhatsAppClient(store, emit, { onOperatorReply: makeOperatorReplyHandler(contextOps) });
try { engine.setComms(whatsapp); } catch (e) { warn('setComms', e); }

const gitService = new GitService(store, emit, providers);
try { engine.setGitService(gitService); } catch (e) { warn('setGitService', e); }
const gitWatcher = new GitWatcher(store, gitService);

// Memory repository: mirrors every project's .continuum into ONE private
// GitHub repo (Settings picks the owner). The engine schedules a debounced
// sync after each checkpoint; a boot sweep catches anything missed offline.
const memorySync = new MemorySync(store, providers, emit);
try { engine.setMemorySync(memorySync); } catch (e) { warn('setMemorySync', e); }
setTimeout(() => { void memorySync.syncAll().catch(() => { /* status carries errors */ }); }, 20_000);

// Cron runner: fires scheduled messages + recurring jobs + due publishes, and backs the agent's
// `schedule_*` MCP tools (gated on `engine.setCron`). Without this, the operator's Schedule queue
// would never fire. Started in boot() once the WS host is up so fired events reach the client.
const cron = new CronRunner(store, engine, emit, (nowMs) => publishing.fireDue(nowMs),
  makeWhatsappAnalyzer({ store, engine, client: whatsapp, emit, intake: (args) => contextIntake(contextOps, args) }));
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

// External MCP: exposes the WHOLE dispatch surface to an OUTSIDE agent (Claude Desktop,
// Cursor, Codex, …) over a loopback+token HTTP endpoint + a stdio shim. Constructed AFTER
// dispatch (which it calls), but createDispatch needs a control handle to (re)start the
// server + report config — so we hand it a thin holder that resolves once externalMcp exists.
let externalMcp: ExternalMcp | null = null;
const mcpControl: ExternalMcpControl = {
  config: () => externalMcp?.config() ?? { enabled: false, running: false },
  apply: () => externalMcp?.apply(),
};

// The full local dispatch — identical to what the renderer reached over Electron IPC.
// getExtensionBridge → null (the native app uses Playwright, not the Chrome extension).
const dispatch = createDispatch(
  store, engine, media, research, publishing, telegram, whatsapp, providers,
  emit, RELAY_URL, gitService, () => null, gitWatcher, browserManager, memorySync, mcpControl,
);

externalMcp = new ExternalMcp({
  store: {
    mcpAccess: () => store.mcpAccess(),
    setMcpAccess: (patch) => store.setMcpAccess(patch),
    mcpToken: () => store.mcpToken(),
    rotateMcpToken: () => store.rotateMcpToken(),
  },
  dispatch: (m, p) => dispatch(m, p),
  shimPath: path.join(shimApp.getPath('userData'), 'mochi-mcp-stdio.cjs'),
  nodePath: process.execPath,
  warn: (label, e) => warn(label, e),
});

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
      await stopScreenHostOwner();
      await stopShadowHostData();
      await stopShadowHost();
      if (accountSessionToken) await authPost('/api/auth/sign-out', {}, accountSessionToken).catch(() => ({ token: '', body: null, status: 0 }));
      stopAccountHost();
      clearAccountToken();
      return { signedIn: false, deviceId: store.deck.deckId, serverUrl: RELAY_URL, devices: [] };
    case 'accountSetSession': {
      const token = typeof params.token === 'string' ? params.token.trim() : '';
      if (!token) {
        await stopScreenHostOwner();
        await stopShadowHostData();
        await stopShadowHost();
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

// ── Shadow host enrollment runtime (Phase 3A2a) ────────────────────────────
// Exactly one lifecycle-managed ShadowHostEnrollmentRuntime, keyed to the
// signed-in account, wired through the same trusted WS dispatch surface the
// renderer (and 3A2b) calls — using the existing account session token, device
// id (deck) and authenticated fetch path. Private/scope material lives only as
// safeStorage ciphertext; the QR is returned ONLY from the explicit create call
// and never logged. Fails visibly/read-only when auth or the vault is unavailable.
let shadowHost: { accountId: string; rt: ShadowHostEnrollmentRuntime } | null = null;
let cachedAccount: { token: string; accountId: string } | null = null;

async function resolveAccountId(): Promise<string> {
  if (!accountSessionToken) throw Object.assign(new Error('not signed in'), { statusCode: 401 });
  if (cachedAccount && cachedAccount.token === accountSessionToken) return cachedAccount.accountId;
  const res = await fetch(`${RELAY_URL}/api/auth/get-session`, { headers: { authorization: `Bearer ${accountSessionToken}` } });
  if (!res.ok) throw Object.assign(new Error(res.status === 401 ? 'session expired' : `session lookup failed (${res.status})`), { statusCode: res.status });
  const data = await res.json().catch(() => null) as { user?: { id?: string } } | null;
  const id = data?.user?.id;
  if (!id) throw Object.assign(new Error('no account session'), { statusCode: 401 });
  cachedAccount = { token: accountSessionToken, accountId: id };
  return id;
}

function shadowHostFile(accountId: string): string {
  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return path.join(shimApp.getPath('userData'), `shadow-host-enrollment.${safe}.json`);
}

async function getShadowHostFor(): Promise<ShadowHostEnrollmentRuntime> {
  const accountId = await resolveAccountId();
  if (shadowHost && shadowHost.accountId === accountId) return shadowHost.rt;
  if (shadowHost) { try { await shadowHost.rt.stop(); } catch { /* noop */ } shadowHost = null; }
  const rt = new ShadowHostEnrollmentRuntime({
    vault: new SafeStorageVault(safeStorage),
    persistence: new FileHostEnrollmentPersistence(shadowHostFile(accountId)),
    session: { get: async () => ({ accountId, hostDeviceId: store.deck.deckId, sessionToken: accountSessionToken, relayOrigin: RELAY_URL }) },
    transport: { fetch: (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<ConstructorParameters<typeof ShadowHostEnrollmentRuntime>[0]['transport']['fetch']> },
  });
  shadowHost = { accountId, rt };
  return rt;
}

async function ensureShadowHostStarted(rt: ShadowHostEnrollmentRuntime): Promise<void> {
  if (rt.status().state === 'running') return;
  try { await rt.start(); } catch (e) { warn('shadowHost.start', e); }
}

async function stopShadowHost(): Promise<void> {
  if (shadowHost) { try { await shadowHost.rt.stop(); } catch { /* noop */ } shadowHost = null; }
  cachedAccount = null;
}

const handleShadowHostCall = createShadowHostDispatch({
  signedIn: () => !!accountSessionToken,
  hostDeviceId: () => store.deck.deckId,
  vaultAvailable: () => new SafeStorageVault(safeStorage).isEncryptionAvailable(),
  getRuntime: () => getShadowHostFor(),
  ensureStarted: (rt) => ensureShadowHostStarted(rt),
  afterApprove: (rt) => onShadowControllerApproved(rt),
  // Phase 3B0 NOTE-2: refresh (deny + rebuild) the live data plane after a revoke.
  afterRevoke: (rt) => onShadowControllerRevoked(rt),
  // Phase 3D1: the host-visible screen-share status + local Stop (registry-backed;
  // the screen coordinator writes it on start/stop). Metadata only, never frames.
  screenShareStatus: () => screenShareRegistry.get(),
  screenShareStop: () => screenShareRegistry.stop(),
});

// ── Shadow host DATA/COMMAND plane (Phase 3A2a) ────────────────────────────
// Exactly one ShadowHostDataService (over a REAL ShadowHostCore) per account,
// composed from the enrollment runtime's scope key + authority fence once a
// controller is enrolled. Controller commands execute ONLY through this strict
// allowlist into the existing brain dispatch (operator gates preserved); their
// results become command-bound completion state events. No new port.
let shadowHostData: { accountId: string; svc: ShadowHostDataService; projection: ShadowProductProjection | null } | null = null;
let shadowHostDataTimer: ReturnType<typeof setInterval> | null = null;

/**
 * A read-only controller command: dispatches a proven READ-ONLY brain method and
 * returns a command-bound checkpoint completion (the raw result never leaves the
 * host). Re-evaluation after a crash is harmless (no external mutation), and the
 * durable completion event is idempotent by content-addressed eventId.
 */
function readOnlyControllerCommand(method: string): HostCommandExecutor {
  return async ({ params, commandId }) => {
    try {
      await dispatch(method, params as Record<string, unknown>);
      return { ok: true, completion: { collection: 'command', op: 'checkpoint', entityId: commandId, revision: 1, payload: { method, ok: true } } };
    } catch {
      // Phase 3B0 NOTE-3: never surface the raw executor exception (which may carry
      // a filesystem path, SQL text, or connection string) into the command ACK —
      // emit a stable generic reason. The ACK builder sanitizes again as a backstop.
      return { ok: false, code: 'exec-error', message: 'command failed' };
    }
  };
}

/**
 * Typed production command registry. Only read-only / event-only methods are
 * representable + registrable (a mutating method cannot be typed or constructed —
 * see `defineShadowCommandRegistry`). Mutating product actions are deferred to 3B,
 * where they must add product-level ATOMIC idempotency before registration.
 */
/**
 * Durable Store-adjacent receipt for capability-gated product-idempotent actions
 * (Section C). One store across accounts (keyed by scopeId); persists exactly-once
 * receipts + conflict detection.
 */
const shadowActionReceipts = new ShadowActionReceiptStore(path.join(shimApp.getPath('userData'), 'shadow-host-core', 'action-receipts'));

/**
 * FROZEN production registry: read-only listing/health + the six capability-gated
 * product-idempotent actions wired through NARROW closures into concrete Store/engine
 * methods (never a generic `dispatch(method)`). Execution-time capability enforcement
 * + durable receipts live in the data service / adapters.
 */
const SHADOW_CONTROLLER_COMMAND_REGISTRY: ShadowCommandRegistry = defineShadowCommandRegistry({
  listProjects: { effectMode: 'read-only', execute: readOnlyControllerCommand('listProjects') },
  health: { effectMode: 'read-only', execute: readOnlyControllerCommand('health') },
  ...buildControllerActionRegistryEntries({
    store: {
      getProject: (id) => store.getProject(id),
      getSession: (id) => store.getSession(id),
      getJob: (id) => store.getJob(id),
      listApprovals: () => store.listApprovals(),
      listSchedules: () => store.listSchedules(),
      claimIdempotentJob: (key, spec) => store.claimIdempotentJob(key, spec as Parameters<typeof store.claimIdempotentJob>[1]),
      // Product-idempotent question answer via the atomic Store seam (durable schedule-disable
      // + deterministic answer Job under the command key). Boot recovery launches a
      // freshly-materialized pending answer Job (idempotentPendingJobIds → recoverSessionRuns).
      claimIdempotentQuestionAnswer: (key, input) => store.claimIdempotentQuestionAnswer(key, input),
      resolveApproval: (id, status) => store.resolveApproval(id, status),
      updateSession: (id, patch) => store.updateSession(id, patch),
    },
    engine: {
      launchJob: (jobId) => { void engine.run(jobId, {}).catch(() => { /* engine records failure on the job */ }); },
      cancelJob: (jobId) => engine.cancel(jobId) !== null,
    },
    receipts: shadowActionReceipts,
  }),
});

function shadowHostCoreDir(accountId: string): string {
  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return path.join(shimApp.getPath('userData'), 'shadow-host-core', safe);
}

async function getShadowHostDataService(): Promise<ShadowHostDataService | null> {
  const accountId = await resolveAccountId();
  const rt = await getShadowHostFor();
  await ensureShadowHostStarted(rt);
  if (shadowHostData && shadowHostData.accountId === accountId) {
    const reason = rt.dataPlaneUnavailableReason();
    if (!reason) return shadowHostData.svc;
    await stopShadowHostData();
  }
  // Phase 3A2b1 Section B: build the FULL data plane — accepted encrypted host
  // data/command service + the all-project redacted ShadowProductProjection sharing
  // ONE ShadowHostCore. The Store singleton is the projection source; a narrow
  // post-durable-write hook drives incremental projection, plus one startup reconcile.
  const plane = rt.buildDataPlane({
    rootDir: shadowHostCoreDir(accountId),
    transport: { fetch: (url, init) => fetch(url, init as RequestInit) as unknown as Parameters<ShadowHostEnrollmentRuntime['buildDataPlane']>[0]['transport']['fetch'] },
    commandRegistry: SHADOW_CONTROLLER_COMMAND_REGISTRY,
    store,
    log: (m) => warn('shadowProjection', m),
  });
  if (!plane) return null;
  // Tear down the prior account's plane FIRST (no cross-account listeners/state).
  if (shadowHostData) { try { shadowHostData.projection?.close(); } catch { /* noop */ } try { shadowHostData.svc.close(); } catch { /* noop */ } }
  store.onDurableChange(plane.projection.onDurableChange);
  shadowHostData = { accountId, svc: plane.svc, projection: plane.projection };
  void plane.projection.start().catch((e) => warn('shadowProjection.start', e));
  return plane.svc;
}

async function getShadowHostDataInactiveReason(): Promise<string> {
  try {
    const rt = await getShadowHostFor();
    await ensureShadowHostStarted(rt);
    return rt.dataPlaneUnavailableReason() ?? 'data plane unavailable';
  } catch {
    return 'runtime-not-running';
  }
}

async function stopShadowHostData(): Promise<void> {
  if (shadowHostDataTimer) { clearInterval(shadowHostDataTimer); shadowHostDataTimer = null; }
  if (shadowHostData) {
    try { store.onDurableChange(null); } catch { /* noop */ }
    try { shadowHostData.projection?.close(); } catch { /* noop */ }
    try { shadowHostData.svc.close(); } catch { /* noop */ }
    shadowHostData = null;
  }
}

/**
 * Phase 3B0 NOTE-2: the SINGLE path that refreshes the live data service's
 * authority from the runtime's current truth — fence, lease expiry, the rotated
 * scope-key id, AND the revoked-controller set. Feeding the revoked set + rotated
 * key id here is what makes the fence `revoked` branch (and every read-only
 * enumeration) deny a revoked controller on the LIVE plane, not only after a
 * restart. A missing fence is a no-op.
 */
function applyLiveHostAuthority(rt: ShadowHostEnrollmentRuntime): void {
  const plane = shadowHostData;
  if (!plane) return;
  const a = rt.liveAuthority();
  if (!a) return;
  plane.svc.setAuthority(a.fence, a.leaseExpiresAt, a.revokedControllerDeviceIds, a.scopeKeyId ?? undefined);
  plane.projection?.setFence(a.fence);
  void screenOwner?.onAuthorityChanged();
}

// ── Phase 3D1 (B2): PRODUCTION host screen-stream owner ─────────────────────────
// Constructs ScreenStreamHostCoordinator, dials /ws/host/screen, drives native
// ScreenCaptureKit via renderer events, receives frames over the loopback seam, and
// writes screenShareRegistry. The configured display source is host-confirmed via the
// Controllers/settings surface and persisted (metadata only) — no start without it.
let screenOwner: ScreenHostOwner | null = null;
let screenPermission: 'granted' | 'denied' | 'undetermined' = 'undetermined';
let screenSourcePolicy: ScreenSourcePolicy | null = loadScreenSourcePolicy();

/** M-A: load the persisted operator-confirmed display (host-local). Revalidated against
 * the live source list on the renderer's first source report, so a stale/removed display
 * doesn't allow a start. */
function loadScreenSourcePolicy(): ScreenSourcePolicy | null {
  try {
    const raw = JSON.parse(readFileSync(SCREEN_SOURCE_PATH, 'utf8')) as Partial<ScreenSourcePolicy>;
    if (raw && typeof raw.sourcePolicyId === 'string' && raw.sourcePolicyId && typeof raw.width === 'number' && typeof raw.height === 'number') {
      return { sourcePolicyId: raw.sourcePolicyId, kind: 'display', label: String(raw.label ?? '').slice(0, 120), width: raw.width, height: raw.height };
    }
  } catch { /* none persisted */ }
  return null;
}

function persistScreenSourcePolicy(p: ScreenSourcePolicy | null): void {
  try {
    if (!p) { unlinkSync(SCREEN_SOURCE_PATH); return; }
    mkdirSync(path.dirname(SCREEN_SOURCE_PATH), { recursive: true });
    writeFileSync(SCREEN_SOURCE_PATH, JSON.stringify(p), { mode: 0o600 });
  } catch { /* best-effort; in-memory selection still governs this session */ }
}

function buildScreenAuthoritySnapshot(rt: ShadowHostEnrollmentRuntime, controllerDeviceId: string): ScreenAuthoritySnapshot | null {
  const a = rt.liveAuthority();
  if (!a) return null;
  const caps = rt.capabilitiesFor(controllerDeviceId) ?? [];
  return {
    fence: a.fence, leaseExpiresAtMs: a.leaseExpiresAt, grantedCapabilities: caps,
    revokedControllerDeviceIds: a.revokedControllerDeviceIds, hostOnline: !!accountSessionToken,
    configuredSourcePolicyId: screenSourcePolicy?.sourcePolicyId ?? null, foreground: true,
  };
}

async function getScreenHostOwner(): Promise<ScreenHostOwner | null> {
  if (screenOwner) return screenOwner;
  if (!accountSessionToken || !screenSourcePolicy) return null;
  const rt = await getShadowHostFor();
  await ensureShadowHostStarted(rt);
  screenOwner = new ScreenHostOwner({
    backend: screenBackend,
    authority: {
      snapshot: (id) => buildScreenAuthoritySnapshot(rt, id),
      hostAgreementPrivate: () => rt.screenHostKeyMaterial()?.hostAgreementPrivate ?? null,
      hostSigningPrivate: () => rt.screenHostKeyMaterial()?.hostSigningPrivate ?? null,
      hostSigningKeyId: () => rt.screenHostKeyMaterial()?.hostSigningKeyId ?? null,
      controllerAgreementPublic: (id) => rt.controllerAgreementPublicFor(id),
      controllerSigningPublic: (id) => rt.controllerSigningPublicFor(id),
      sourcePolicy: () => screenSourcePolicy,
    },
    native: {
      permission: () => screenPermission,
      start: (opts) => emit('screen-capture-start', opts, { desktopOnly: true }),
      stop: () => emit('screen-capture-stop', {}, { desktopOnly: true }),
    },
    registry: screenShareRegistry,
    dialRelay: () => new ScreenRelayHostLink({ relayOrigin: RELAY_URL, sessionToken: accountSessionToken, hostDeviceId: store.deck.deckId }),
    now: () => Date.now(),
    audit: () => { /* metadata-only audit is emitted via the coordinator's status events */ },
  });
  screenOwner.start();
  return screenOwner;
}

async function stopScreenHostOwner(): Promise<void> {
  if (!screenOwner) return;
  try { await screenOwner.stop(); } catch { /* */ }
  screenOwner = null;
}

/** Renderer/native → brain screen calls (loopback IPC seam). Frames are latest-only,
 * bounded, and forwarded to the owner to seal + relay — never persisted. */
async function handleScreenCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'screenPermission') { const p = params.permission; if (p === 'granted' || p === 'denied' || p === 'undetermined') screenPermission = p; return { ok: true }; }
  // M-A: EXPLICIT operator confirmation of a display (from the Controllers "Screen
  // sharing" card). Persisted host-local; builds the owner so a stream can start.
  if (method === 'screenConfigureSource') {
    const id = String(params.sourcePolicyId ?? '');
    const width = Number(params.width ?? 0); const height = Number(params.height ?? 0);
    const label = String(params.label ?? '');
    if (!id || !(width > 0) || !(height > 0)) { return { ok: false, configured: false }; }
    screenSourcePolicy = { sourcePolicyId: id, kind: 'display', label: label.slice(0, 120), width, height };
    persistScreenSourcePolicy(screenSourcePolicy);
    await getScreenHostOwner();
    return { ok: true, configured: true };
  }
  // M-A: operator clears the confirmed display → any active stream stops (source-required).
  if (method === 'screenClearSource') {
    screenSourcePolicy = null;
    persistScreenSourcePolicy(null);
    await screenOwner?.onAuthorityChanged();
    return { ok: true, configured: false };
  }
  // M-A: the UI reads the current confirmed selection (host-local). The source LIST is
  // enumerated by the renderer via the native bridge — never here — so no window titles
  // or app names cross this seam.
  if (method === 'screenSourceState') {
    return { ok: true, selected: screenSourcePolicy ? { sourcePolicyId: screenSourcePolicy.sourcePolicyId, label: screenSourcePolicy.label, width: screenSourcePolicy.width, height: screenSourcePolicy.height } : null };
  }
  // M-A: the renderer reports the CURRENTLY-available display ids on boot / source-list
  // change; if the persisted selection is no longer present, drop it (→ source-required)
  // and stop any active stream. Revalidation only — never an auto-pick.
  if (method === 'screenReportSources') {
    const ids = Array.isArray(params.ids) ? (params.ids as unknown[]).map((x) => String(x)) : [];
    if (screenSourcePolicy && !ids.includes(screenSourcePolicy.sourcePolicyId)) {
      screenSourcePolicy = null;
      persistScreenSourcePolicy(null);
      await screenOwner?.onAuthorityChanged();
      return { ok: true, revalidated: false };
    }
    return { ok: true, revalidated: true };
  }
  if (method === 'screenFrame') {
    const owner = screenOwner; if (!owner) return { ok: false };
    const b64 = String(params.b64 ?? ''); const ts = Number(params.ts ?? Date.now());
    if (!b64 || b64.length > 2_000_000) return { ok: false }; // bounded; latest-only
    let bytes: Buffer;
    try { bytes = Buffer.from(b64, 'base64'); } catch { return { ok: false }; }
    owner.pushFrame(new Uint8Array(bytes), ts);
    return { ok: true };
  }
  if (method === 'screenCaptureError') { screenOwner?.pushError(String(params.reason ?? 'capture error').slice(0, 120)); return { ok: true }; }
  return { ok: false };
}

/** Renew the host lease before it expires and atomically refresh the data service authority. */
const SHADOW_LEASE_RENEW_BEFORE_MS = 120_000;
async function renewShadowHostLease(): Promise<void> {
  try {
    const rt = await getShadowHostFor();
    // Recover any durable pending renewal intent first (crash between the atomic
    // server commit and local persistence) — replays the same renewalId idempotently.
    const resumed = await rt.resumePendingRenewal();
    if (resumed) applyLiveHostAuthority(rt);
    const authority = rt.liveAuthority();
    // Host lease continuity is independent of the controller data plane. After the
    // last controller is revoked the plane is intentionally torn down, but the host
    // authority must keep renewing so account Mac discovery remains online.
    const leaseExpiresAt = authority?.leaseExpiresAt ?? 0;
    if (leaseExpiresAt > 0 && leaseExpiresAt - Date.now() <= SHADOW_LEASE_RENEW_BEFORE_MS) {
      const renewed = await rt.renewLease();
      if (renewed) applyLiveHostAuthority(rt);
    }
  } catch (e) { warn('shadowHostData.renew', e); }
}

/**
 * Phase 3B0 NOTE-2: after a controller REVOKE the scope key is rotated to a fresh
 * random key, so the live plane must (a) immediately deny the revoked controller
 * by feeding the new revoked set into the in-force authority, then (b) tear down
 * so the very next access rebuilds a plane bound to the ROTATED scope key. No
 * stale poller/service survives with the old authority or key.
 */
async function onShadowControllerRevoked(rt: ShadowHostEnrollmentRuntime): Promise<void> {
  if (!shadowHostData) return;
  applyLiveHostAuthority(rt); // deny the revoked controller on the live authority right now
  try { store.onDurableChange(null); } catch { /* noop */ }
  try { shadowHostData.projection?.close(); } catch { /* noop */ }
  try { shadowHostData.svc.close(); } catch { /* noop */ }
  shadowHostData = null; // next getShadowHostDataService() rebuilds under the rotated scope key
}

async function onShadowControllerApproved(rt: ShadowHostEnrollmentRuntime): Promise<void> {
  await ensureShadowHostStarted(rt);
  if (shadowHostData) applyLiveHostAuthority(rt);
  const svc = await getShadowHostDataService();
  if (!svc) return;
  try { await svc.publishAllPending(); } catch (e) { warn('shadowHostData.approve.publish', e); }
}

async function handleShadowHostDataCall(method: string): Promise<unknown> {
  if (!accountSessionToken) throw Object.assign(new Error('not signed in'), { statusCode: 401 });
  const svc = await getShadowHostDataService();
  if (!svc) return { active: false, reason: await getShadowHostDataInactiveReason() };
  switch (method) {
    case 'shadowHostDataStatus':
      return { active: true, ...svc.status() };
    case 'shadowHostDataSync': {
      await renewShadowHostLease();
      const published = await svc.publishAllPending();
      const commands = await svc.pollAndExecuteCommands();
      return { active: true, published, commands };
    }
    default:
      throw Object.assign(new Error('unknown shadowHostData method'), { statusCode: 404 });
  }
}

/** Best-effort live sync loop (publish pending events + pull/execute commands). */
function startShadowHostDataLoop(): void {
  if (shadowHostDataTimer) return;
  shadowHostDataTimer = setInterval(() => {
    if (!accountSessionToken) return;
    void (async () => {
      try {
        const rt = await getShadowHostFor();
        await ensureShadowHostStarted(rt);
        await renewShadowHostLease();
        const svc = await getShadowHostDataService();
        if (!svc) return;
        await svc.publishAllPending();
        await svc.pollAndExecuteCommands();
      } catch (e) { warn('shadowHostData.loop', e); }
    })();
  }, 15_000);
  if (typeof shadowHostDataTimer.unref === 'function') shadowHostDataTimer.unref();
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

// The ws-host generates its token INSIDE startWsHost, so hold it in a mutable ref the file-preview
// handler validates against once the host has resolved (requests can only arrive after listen).
const tokenRef = { value: '' };
const filePreview = makeFilePreviewHttp({ store, getToken: () => tokenRef.value });

// HTTP handler for the WebKit app bundle, file-preview stream, and design live-preview routes.
const httpHandler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean> => {
  if (await filePreview(req, res)) return true;
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
    if (method.startsWith('shadowHostData')) return await handleShadowHostDataCall(method);
    if (method.startsWith('shadowHost')) return await handleShadowHostCall(method, params);
    // Phase 3D1 (B2): renderer/native → brain screen seam (frame / permission / source
    // config / capture error). NOT the native screenCapture* methods (those go to Swift).
    if (method === 'screenFrame' || method === 'screenPermission' || method === 'screenConfigureSource' || method === 'screenCaptureError') return await handleScreenCall(method, params);
    return await dispatch(method, params);
  }, httpHandler);
  tokenRef.value = host.token; // arm the file-preview route with the real host token
  emitToClients = host.emit;

  process.stdout.write(JSON.stringify({ ready: true, port: host.port, token: host.token }) + '\n');
  process.stderr.write(`[sidecar] full dispatch live on 127.0.0.1:${host.port}\n`);

  // Best-effort boot resumes (run AFTER the host is up so their events have somewhere to go).
  // SessionRunQueue recovery: settleOrphanedRuns() (above) already terminalized any
  // crashed lease OWNERS; now heal each session lease whose owner is terminal/stale and
  // re-dispatch the promoted (never-started) queued waiter EXACTLY ONCE. A partially-run
  // owner is never re-run — only queued work that never began.
  try { engine.recoverSessionRuns(); } catch (e) { warn('recoverSessionRuns', e); }
  try { externalMcp?.start(); } catch (e) { warn('externalMcp.start', e); }
  try { cron.start(); } catch (e) { warn('cron.start', e); }
  try { media.resumeOnBoot(); } catch (e) { warn('media.resumeOnBoot', e); }
  try { telegram.resumeOnBoot(); } catch (e) { warn('telegram.resumeOnBoot', e); }
  try { whatsapp.resumeOnBoot(); } catch (e) { warn('whatsapp.resumeOnBoot', e); }
  const persistedToken = readAccountToken();
  if (persistedToken) {
    try { startAccountHost(persistedToken); } catch (e) { warn('account host', e); }
  }
  try { startShadowHostDataLoop(); } catch (e) { warn('shadowHostData.loop.start', e); }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      try { void stopScreenHostOwner(); } catch { /* noop */ }
      try { void stopShadowHostData(); } catch { /* noop */ }
      try { void stopShadowHost(); } catch { /* noop */ }
      try { stopAccountHost(); } catch { /* noop */ }
      try { cron.stop(); } catch { /* noop */ }
      try { externalMcp?.stop(); } catch { /* noop */ }
      try { gitWatcher.detachAll(); } catch { /* noop */ }
      try { void browserManager.shutdown(); } catch { /* noop */ }
      try { host.close(); } catch { /* noop */ }
      process.exit(0);
    });
  }
}

void boot();
