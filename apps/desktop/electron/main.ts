import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { Store } from './store.js';
import { LocalEngine } from './engine.js';
import { Providers } from './providers.js';
import { createDispatch } from './localApi.js';
import { RelayClient } from './relay.js';
import { CronRunner } from './cron.js';

const RENDERER_DIST = path.join(__dirname, '../dist');
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
const RELAY_URL = process.env['MAESTRO_RELAY_URL'] || 'wss://api.nexalance.cloud/ws';

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
      preload: path.join(__dirname, 'preload.mjs'),
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

  let relay: RelayClient | null = null;
  const emit = (name: string, data: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('maestro:event', { name, data }); } catch { /* window closing */ }
    }
    relay?.event(name, data);
    relay?.pushSnapshot();
  };

  const engine = new LocalEngine(store, emit, providers);
  const dispatch = createDispatch(store, engine, providers, emit, RELAY_URL);

  relay = new RelayClient({
    url: RELAY_URL,
    deckId: store.deck.deckId,
    deckSecret: store.deck.deckSecret,
    accessToken: store.accessToken,
    getSnapshot: () => ({ ...store.snapshot(providers.list()), engineStatus: engine.statuses() }),
    onCommand: (method, params) => dispatch(method, params),
  });
  relay.start();

  const cron = new CronRunner(store, engine, emit);
  cron.start();
  app.on('before-quit', () => { cron.stop(); relay?.stop(); });

  ipcMain.handle('maestro:call', async (_e, method: string, params: Record<string, unknown>) => {
    try {
      const data = await dispatch(method, params ?? {});
      return { ok: true, data };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number };
      return { ok: false, error: err?.message ?? 'failed', status: err?.statusCode ?? 500 };
    }
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
