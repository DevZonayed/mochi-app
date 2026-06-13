import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { existsSync, realpathSync, promises as fsp } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { Store } from './store.js';
import { LocalEngine } from './engine.js';
import { MediaEngine } from './media.js';
import { ResearchEngine } from './research.js';
import { PublishingEngine } from './publishing.js';
import { TelegramBot } from './telegram.js';
import { Providers } from './providers.js';
import type { Approval } from './store.js';
import { createDispatch } from './localApi.js';
import { buildModelGroups } from './models.js';
import { RelayClient } from './relay.js';
import { CronRunner } from './cron.js';

const RENDERER_DIST = path.join(__dirname, '../dist');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RELAY_URL = process.env['MAESTRO_RELAY_URL'] || 'wss://api.nexalance.cloud/ws';

// The preload is emitted as either preload.mjs or preload.js depending on the
// build; load whichever actually exists. If this resolves wrong, window.maestro
// never loads → the renderer falls back to the relay (the "Unauthorized" bug).
const PRELOAD = ['preload.mjs', 'preload.js']
  .map((f) => path.join(__dirname, f))
  .find((p) => existsSync(p)) ?? path.join(__dirname, 'preload.mjs');

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#e7e9f3',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
    },
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'));
  }
}

/* ── Maestro core boots WITH the app: local store + local engine + relay ──
   Everything lives and executes on this Mac. The relay connection exists only
   so the phone/web remotes can mirror state and send commands here. */

app.whenReady().then(() => {
  const store = new Store();
  store.settleOrphanedRuns(); // jobs from a previous app instance can't finish — settle them honestly
  const providers = new Providers(store);

  // Apply the persisted "open at login" preference, and re-apply whenever it changes.
  const applyLoginItem = (openAtLogin: boolean) => { try { app.setLoginItemSettings({ openAtLogin }); } catch { /* unsupported */ } };
  applyLoginItem(store.getSettings().openAtLogin);

  let relay: RelayClient | null = null;
  let telegram: TelegramBot | null = null;
  const emit = (name: string, data: unknown, opts?: { live?: boolean }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('maestro:event', { name, data }); } catch { /* window closing */ }
    }
    // Streaming frames (50ms cadence) are local-only: the relay/phone gets the
    // ~1s checkpoint updates instead of a snapshot push per frame.
    if (opts?.live) return;
    if (name === 'settings' && data && typeof data === 'object') applyLoginItem(!!(data as { openAtLogin?: boolean }).openAtLogin);
    // A new pending approval (e.g. reviewer NEEDS WORK) → push to Telegram gates.
    if (name === 'approval' && telegram && (data as Approval)?.status === 'pending') telegram.notifyApproval(data as Approval);
    relay?.event(name, data);
    relay?.pushSnapshot();
  };

  const engine = new LocalEngine(store, emit, providers);
  const media = new MediaEngine(store, emit, () => providers.getLocalKey('fal'));
  media.resumeOnBoot();
  const research = new ResearchEngine(store, engine, emit);
  const publishing = new PublishingEngine(store, emit);
  telegram = new TelegramBot(store, engine, providers, emit);
  telegram.resumeOnBoot();
  const dispatch = createDispatch(store, engine, media, research, publishing, telegram, providers, emit, RELAY_URL);

  relay = new RelayClient({
    url: RELAY_URL,
    deckId: store.deck.deckId,
    deckSecret: store.deck.deckSecret,
    accessToken: store.accessToken,
    getSnapshot: () => ({ ...store.snapshot(providers.list()), engineStatus: engine.statuses(), mediaRates: media.rates(), models: buildModelGroups(engine.statuses()) }),
    onCommand: (method, params) => dispatch(method, params),
  });
  relay.start();

  const cron = new CronRunner(store, engine, emit, (nowMs) => publishing.fireDue(nowMs));
  cron.start();
  app.on('before-quit', () => { cron.stop(); relay?.stop(); telegram?.stop(); });

  ipcMain.handle('maestro:call', async (_e, method: string, params: Record<string, unknown>) => {
    try {
      const data = await dispatch(method, params ?? {});
      return { ok: true, data };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number };
      return { ok: false, error: err?.message ?? 'failed', status: err?.statusCode ?? 500 };
    }
  });

  // Native folder picker — DESKTOP-ONLY (never exposed to the relay/remotes).
  // The coding agent opens an existing local folder as a project workspace.
  ipcMain.handle('maestro:pickFolder', async () => {
    const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const res = w
      ? await dialog.showOpenDialog(w, { properties: ['openDirectory', 'createDirectory'], title: 'Open project folder' })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Open project folder' });
    if (res.canceled || !res.filePaths[0]) return { ok: true, data: null };
    return { ok: true, data: await dispatch('inspectFolder', { path: res.filePaths[0] }) };
  });

  // Reveal a path in Finder — desktop-only, path-guarded. Expands a leading ~.
  ipcMain.handle('maestro:revealPath', async (_e, p: string) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'no path' };
    const abs = p.startsWith('~/') || p === '~' ? path.join(app.getPath('home'), p.slice(1)) : p;
    if (existsSync(abs)) { shell.showItemInFolder(abs); return { ok: true }; }
    return { ok: false, error: 'path not found' };
  });

  // Import a local media file as an asset — DESKTOP-ONLY (native picker).
  ipcMain.handle('maestro:importAsset', async (_e, projectId: string | null) => {
    const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const opts = { properties: ['openFile' as const], title: 'Import media', filters: [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a'] }] };
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return { ok: true, data: null };
    try { return { ok: true, data: await dispatch('importAsset', { path: res.filePaths[0], projectId: projectId ?? null }) }; }
    catch (e) { const err = e as { message?: string }; return { ok: false, error: err?.message ?? 'import failed' }; }
  });

  /* Resolve `rel` to a canonical path that is provably INSIDE the project root.
     Defends against `..` escapes and symlinks pointing out of the repo. Accepts
     either a path relative to the root or an absolute path that lands inside it. */
  const resolveInsideRoot = (rawRoot: string, rel: string): string => {
    const root = rawRoot.startsWith('~/') || rawRoot === '~' ? path.join(app.getPath('home'), rawRoot.slice(1)) : rawRoot;
    const rootReal = realpathSync(path.resolve(root));
    const target = path.resolve(rootReal, String(rel ?? ''));
    const relToRoot = path.relative(rootReal, target);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new Error('path escapes project');
    const real = realpathSync(target);
    const relReal = path.relative(rootReal, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('symlink escapes project');
    return real;
  };
  const projectRoot = (projectId: unknown): string => {
    const root = store.getProject(String(projectId))?.path;
    if (!root) throw new Error('this project has no folder on disk');
    return root;
  };

  // Read a file's text — DESKTOP-ONLY, confined to the project folder. Never
  // added to the relay dispatch, so remotes can't read local files.
  ipcMain.handle('maestro:readFile', async (_e, projectId: string, rel: string) => {
    try {
      const real = resolveInsideRoot(projectRoot(projectId), rel);
      const st = await fsp.stat(real);
      if (!st.isFile()) return { ok: false, error: 'not a file' };
      if (st.size > 2 * 1024 * 1024) {
        const fd = await fsp.open(real, 'r');
        try { const buf = Buffer.alloc(512 * 1024); const { bytesRead } = await fd.read(buf, 0, buf.length, 0); return { ok: true, data: { path: real, text: buf.subarray(0, bytesRead).toString('utf8'), bytes: st.size, truncated: true } }; }
        finally { await fd.close(); }
      }
      const text = await fsp.readFile(real, 'utf8');
      if (text.includes('\u0000')) return { ok: false, error: 'binary file' };
      return { ok: true, data: { path: real, text, bytes: st.size, truncated: false } };
    } catch (e) { return { ok: false, error: (e as Error)?.message ?? 'read failed' }; }
  });

  // List a directory's immediate entries — DESKTOP-ONLY, confined to the project.
  ipcMain.handle('maestro:listDir', async (_e, projectId: string, rel: string) => {
    try {
      const real = resolveInsideRoot(projectRoot(projectId), rel);
      const st = await fsp.stat(real);
      if (!st.isDirectory()) return { ok: false, error: 'not a directory' };
      const dirents = await fsp.readdir(real, { withFileTypes: true });
      const entries = dirents
        .filter(d => d.name !== '.git' && d.name !== 'node_modules' && d.name !== '.DS_Store')
        .slice(0, 5000)
        .map(d => ({ name: d.name, path: path.join(real, d.name), kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
      return { ok: true, data: { path: real, entries } };
    } catch (e) { return { ok: false, error: (e as Error)?.message ?? 'list failed' }; }
  });

  // Run/Terminal: spawn a shell command in the project folder and stream output
  // back over 'maestro:cmd-output'. DESKTOP-ONLY (renderer↔main) — never on the
  // relay, so remotes can't run commands on this Mac.
  const runningCmds = new Map<string, ChildProcess>();
  ipcMain.handle('maestro:runCommand', async (e, projectId: string, command: string) => {
    try {
      const root = store.getProject(String(projectId))?.path;
      if (!root) return { ok: false, error: 'this project has no folder' };
      if (typeof command !== 'string' || !command.trim()) return { ok: false, error: 'command required' };
      const runId = `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}`;
      const child = spawn('/bin/zsh', ['-lc', command], { cwd: root, env: { ...process.env } });
      runningCmds.set(runId, child);
      const send = (stream: string, chunk: string, code?: number) => { try { e.sender.send('maestro:cmd-output', { runId, stream, chunk, code }); } catch { /* window gone */ } };
      child.stdout?.on('data', (d: Buffer) => send('out', String(d)));
      child.stderr?.on('data', (d: Buffer) => send('err', String(d)));
      child.on('close', (code) => { runningCmds.delete(runId); send('exit', '', code ?? 0); });
      child.on('error', (err) => { runningCmds.delete(runId); send('err', err.message + '\n'); send('exit', '', 1); });
      return { ok: true, data: { runId } };
    } catch (err) { return { ok: false, error: (err as Error)?.message ?? 'run failed' }; }
  });
  ipcMain.handle('maestro:killCommand', async (_e, runId: string) => {
    const c = runningCmds.get(String(runId));
    if (c) { try { c.kill('SIGTERM'); } catch { /* gone */ } runningCmds.delete(String(runId)); }
    return { ok: true };
  });

  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
    win = null;
  }
});
