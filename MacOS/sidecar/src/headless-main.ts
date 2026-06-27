// Headless entry for the Maestro brain. Mirrors the construction in apps/desktop/electron/main.ts
// (the `app.whenReady()` block) MINUS the Electron-window pieces (BrowserWindow, protocol handler,
// relay HostClient, P2P, updater, the windowed ExtensionBridge). It builds the SAME
// `createDispatch(...)` the renderer talks to and serves it over the loopback WS host, so the
// native SwiftUI app gets the full local RPC surface — identical to what `window.maestro.call`
// reached. Brain logic is unchanged; only the transport differs (WS instead of Electron IPC).

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app as shimApp } from './electron-shim.ts';
import { startWsHost } from './ws-host.ts';
import { serveDesign } from './design-serve.ts';

import { Store } from '../../../apps/desktop/electron/store.js';
import { Providers } from '../../../apps/desktop/electron/providers.js';
import { LocalEngine } from '../../../apps/desktop/electron/engine.js';
import { MediaEngine } from '../../../apps/desktop/electron/media.js';
import { ResearchEngine } from '../../../apps/desktop/electron/research.js';
import { PublishingEngine } from '../../../apps/desktop/electron/publishing.js';
import { CodexBridge } from '../../../apps/desktop/electron/codex-bridge.js';
import { TelegramBot } from '../../../apps/desktop/electron/telegram.js';
import { WhatsAppClient } from '../../../apps/desktop/electron/whatsapp.js';
import { GitService } from '../../../apps/desktop/electron/git-service.js';
import { GitWatcher } from '../../../apps/desktop/electron/git-watcher.js';
import { CronRunner } from '../../../apps/desktop/electron/cron.js';
import { makeWhatsappAnalyzer } from '../../../apps/desktop/electron/whatsapp-analyze.js';
import { createDispatch } from '../../../apps/desktop/electron/localApi.js';
import { setEnginesRoot } from '../../../apps/desktop/electron/engines.js';
import { bootstrapNodePath } from '../../../apps/desktop/electron/node-shim.js';

const RELAY_URL = (process.env.MAESTRO_SERVER_URL || 'https://api.nexalance.cloud').replace(/\/$/, '');

function warn(label: string, e: unknown) {
  process.stderr.write(`[sidecar] ${label}: ${(e as Error)?.message ?? e}\n`);
}

// --- event emitter: broadcast over the WS host (filled in once the host is up) ---
let emitToClients: ((name: string, data: unknown) => void) | null = null;
const emit = (name: string, data: unknown, _opts?: { live?: boolean; desktopOnly?: boolean }) => {
  emitToClients?.(name, data);
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

// The full local dispatch — identical to what the renderer reached over Electron IPC.
// getExtensionBridge → null for now (the browser-extension control channel is a later phase).
const dispatch = createDispatch(
  store, engine, media, research, publishing, telegram, whatsapp, providers,
  emit, RELAY_URL, gitService, () => null, gitWatcher,
);

// HTTP handler for the design live-preview route: /design/<projectId>/<rel…>
const httpHandler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean> => {
  const url = req.url ?? '';
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
  const host = await startWsHost((method, params) => dispatch(method, params), httpHandler);
  emitToClients = host.emit;

  process.stdout.write(JSON.stringify({ ready: true, port: host.port, token: host.token }) + '\n');
  process.stderr.write(`[sidecar] full dispatch live on 127.0.0.1:${host.port}\n`);

  // Best-effort boot resumes (run AFTER the host is up so their events have somewhere to go).
  try { cron.start(); } catch (e) { warn('cron.start', e); }
  try { media.resumeOnBoot(); } catch (e) { warn('media.resumeOnBoot', e); }
  try { telegram.resumeOnBoot(); } catch (e) { warn('telegram.resumeOnBoot', e); }
  try { whatsapp.resumeOnBoot(); } catch (e) { warn('whatsapp.resumeOnBoot', e); }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      try { cron.stop(); } catch { /* noop */ }
      try { gitWatcher.detachAll(); } catch { /* noop */ }
      try { host.close(); } catch { /* noop */ }
      process.exit(0);
    });
  }
}

void boot();
