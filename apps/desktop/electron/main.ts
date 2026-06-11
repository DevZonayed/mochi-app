import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { LocalEngine } from './engine.js';
import { MediaEngine } from './media.js';
import { ResearchEngine } from './research.js';
import { PublishingEngine } from './publishing.js';
import { TelegramBot } from './telegram.js';
import { Providers } from './providers.js';
import type { Approval } from './store.js';
import { createDispatch } from './localApi.js';
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
  const providers = new Providers(store);

  // Apply the persisted "open at login" preference, and re-apply whenever it changes.
  const applyLoginItem = (openAtLogin: boolean) => { try { app.setLoginItemSettings({ openAtLogin }); } catch { /* unsupported */ } };
  applyLoginItem(store.getSettings().openAtLogin);

  let relay: RelayClient | null = null;
  let telegram: TelegramBot | null = null;
  const emit = (name: string, data: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('maestro:event', { name, data }); } catch { /* window closing */ }
    }
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
    getSnapshot: () => ({ ...store.snapshot(providers.list()), engineStatus: engine.statuses(), mediaRates: media.rates() }),
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

  // Reveal a project's folder in Finder — desktop-only, path-guarded.
  ipcMain.handle('maestro:revealPath', async (_e, p: string) => {
    if (typeof p === 'string' && p && existsSync(p)) { shell.showItemInFolder(p); return { ok: true }; }
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
