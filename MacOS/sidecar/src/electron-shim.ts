// Headless replacement for Electron's `electron` module. The brain imports a handful of
// Electron APIs; running it outside Electron means satisfying that surface with Node + native
// equivalents. Native, user-facing affordances (folder pick, Finder reveal, notifications) are
// owned by the SwiftUI host and arrive as RPC params, so here they are no-ops/stubs.
//
// The resolve hook (hooks.mjs) aliases `import … from 'electron'` to this file.

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';

const HOME = os.homedir();
const APP_SUPPORT = path.join(HOME, 'Library', 'Application Support');

// Last-resort version if neither the launcher env nor the bundle Info.plist can
// be read (e.g. running the sidecar straight from source in dev). This is a
// FALLBACK only — the packaged app reports its real CFBundleShortVersionString
// via resolveAppVersion() below, so a stale constant here never reaches users.
const FALLBACK_VERSION = '0.0.0-dev';

/** Pull CFBundleShortVersionString out of an Info.plist's text. The plist we
    generate (webview-app/package-app.sh) is a flat <key>/<string> dict, so a
    tolerant regex is enough and avoids a plist-parser dependency. */
export function parseBundleVersion(plistText: string): string | null {
  const m = plistText.match(
    /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/,
  );
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** Walk up from a starting path looking for an enclosing `.app/Contents/Info.plist`
    and return its CFBundleShortVersionString. Returns null outside a bundle. */
export function readBundleVersion(startPath: string): string | null {
  let dir = path.dirname(startPath);
  // The sidecar node lives at <App>.app/Contents/Resources/sidecar/bin/node, so
  // Info.plist is a few levels up. Bound the walk so we never scan the whole disk.
  for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i++) {
    if (path.basename(dir) === 'Contents') {
      const plist = path.join(dir, 'Info.plist');
      try {
        if (existsSync(plist)) {
          const v = parseBundleVersion(readFileSync(plist, 'utf8'));
          if (v) return v;
        }
      } catch { /* unreadable plist — keep climbing */ }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** The app version reported to the brain (health, feedback, etc.). Order:
      1. MAESTRO_VERSION, injected by the Swift launcher from Bundle.main.
      2. The enclosing packaged app's Info.plist (self-heals if the env is unset).
      3. A dev fallback.
    Resolved once and memoised — the version can't change within a process. */
let cachedVersion: string | null = null;
export function resolveAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  const env = process.env.MAESTRO_VERSION?.trim();
  cachedVersion =
    (env && env.length ? env : null)
    ?? readBundleVersion(process.execPath)
    ?? FALLBACK_VERSION;
  return cachedVersion;
}

/** The `@maestro/<subdir>` userData folder for a release channel. Each channel is
    ISOLATED so production / preview / development never share a store, token, or
    runtime. Absent/unknown channel → production (safe default). */
export function channelSubdir(channel?: string): string {
  switch (channel) {
    case 'preview': return 'desktop-preview';
    case 'development': return 'desktop-development';
    default: return 'desktop'; // production, unknown, or unset
  }
}

/** Resolve the userData path WITHOUT side effects (no mkdir), so it's unit-safe.
    Precedence: an explicit MAESTRO_USER_DATA_DIR (the Swift launcher injects the
    channel dir there) always wins; otherwise the channel-specific default from
    MAESTRO_CHANNEL. */
export function resolveUserDataPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MAESTRO_USER_DATA_DIR;
  if (override) {
    return override.startsWith('~/') || override === '~'
      ? path.join(HOME, override.slice(1))
      : path.resolve(override);
  }
  return path.join(APP_SUPPORT, '@maestro', channelSubdir(env.MAESTRO_CHANNEL));
}

function userDataDir(): string {
  const dir = resolveUserDataPath();
  try { mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return dir;
}

type PathName =
  | 'home' | 'appData' | 'userData' | 'temp' | 'exe' | 'desktop'
  | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | 'logs';

export const app = {
  isPackaged: false,
  getName: () => '@maestro/desktop',
  getVersion: () => resolveAppVersion(),
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
