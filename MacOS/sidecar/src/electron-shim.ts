// Headless replacement for Electron's `electron` module. The brain imports a handful of
// Electron APIs; running it outside Electron means satisfying that surface with Node + native
// equivalents. Native, user-facing affordances (folder pick, Finder reveal, notifications) are
// owned by the SwiftUI host and arrive as RPC params, so here they are no-ops/stubs.
//
// The resolve hook (hooks.mjs) aliases `import … from 'electron'` to this file.

import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const HOME = os.homedir();
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support');

function userDataDir(): string {
  const override = process.env.MAESTRO_USER_DATA_DIR;
  if (override) {
    const resolved = override.startsWith('~/') || override === '~'
      ? path.join(HOME, override.slice(1))
      : path.resolve(override);
    try { mkdirSync(resolved, { recursive: true }); } catch { /* noop */ }
    return resolved;
  }
  const dir = path.join(APP_SUPPORT, '@maestro', 'desktop');
  try { mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return dir;
}

type PathName =
  | 'home' | 'appData' | 'userData' | 'temp' | 'exe' | 'desktop'
  | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | 'logs';

export const app = {
  isPackaged: false,
  getName: () => '@maestro/desktop',
  getVersion: () => process.env.MAESTRO_VERSION ?? '0.1.28',
  getPath(name: PathName): string {
    switch (name) {
      case 'home': return HOME;
      case 'appData': return APP_SUPPORT;
      case 'userData': return userDataDir();
      case 'temp': return os.tmpdir();
      case 'exe': return process.execPath;
      case 'desktop': return path.join(HOME, 'Desktop');
      case 'documents': return path.join(HOME, 'Documents');
      case 'downloads': return path.join(HOME, 'Downloads');
      case 'music': return path.join(HOME, 'Music');
      case 'pictures': return path.join(HOME, 'Pictures');
      case 'videos': return path.join(HOME, 'Movies');
      case 'logs': return path.join(userDataDir(), 'logs');
      default: return userDataDir();
    }
  },
  getAppPath: () => process.cwd(),
  whenReady: () => Promise.resolve(),
  on: () => app,
  once: () => app,
  quit: () => process.exit(0),
  exit: (code = 0) => process.exit(code),
  requestSingleInstanceLock: () => true,
  setLoginItemSettings: (_: unknown) => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setAppUserModelId: (_: string) => {},
  dock: { setBadge: (_: string) => {}, hide: () => {}, show: () => {} },
};

// TODO(P1): back safeStorage with the macOS Keychain via the Swift host. Until provider
// secrets are wired, this passthrough is unused (Providers is not constructed in P0).
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => Buffer.from(b).toString('utf8'),
};

class NoopEmitter { on() { return this; } once() { return this; } removeListener() { return this; } removeAllListeners() { return this; } emit() { return false; } }

export const ipcMain = { handle() {}, handleOnce() {}, on() {}, once() {}, removeHandler() {}, removeAllListeners() {} };
export const powerMonitor = new NoopEmitter();
export const nativeTheme = Object.assign(new NoopEmitter(), { shouldUseDarkColors: false, themeSource: 'system' });

export class BrowserWindow extends NoopEmitter {
  webContents = new NoopEmitter();
  static getAllWindows() { return []; }
  static fromWebContents() { return null; }
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  show() {} hide() {} focus() {} close() {} destroy() {} isDestroyed() { return false; }
  setBounds() {} getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
}

export class Notification extends NoopEmitter { show() {} close() {} static isSupported() { return false; } }

export const shell = {
  openPath: async (_: string) => '',
  showItemInFolder: (_: string) => {},
  openExternal: async (_: string) => {},
  trashItem: async (_: string) => {},
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
  showMessageBox: async () => ({ response: 0 }),
};

export const protocol = {
  handle: (_: string, __: unknown) => {},
  registerSchemesAsPrivileged: (_: unknown) => {},
  registerFileProtocol: () => true,
};

export const webUtils = { getPathForFile: (f: { path?: string }) => f?.path ?? '' };
export const clipboard = { writeText: (_: string) => {}, readText: () => '' };
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) };

export default {
  app, safeStorage, ipcMain, powerMonitor, nativeTheme, BrowserWindow, Notification,
  shell, dialog, protocol, webUtils, clipboard, nativeImage,
};
