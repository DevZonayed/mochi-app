/* Auto-update — wraps electron-updater (Squirrel.Mac / NSIS / AppImage) and
   funnels its whole lifecycle into ONE `update` event on the desktop windows.
   The feed + installers live on GitHub Releases (see electron-builder.yml).

   This is the only unit that touches electron-updater. main.ts creates one
   Updater, registers the `update.*` IPC methods against it, and starts it.
   Update events are DESKTOP-ONLY: they describe THIS Mac's binary, so they are
   never relayed to the phone/web (emit(..., { desktopOnly: true })). */

import { app, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import electronUpdater, { type UpdateInfo, type ProgressInfo } from 'electron-updater';

const { autoUpdater } = electronUpdater;

// ── The one switch ──────────────────────────────────────────────────────────
// macOS will only SILENTLY self-replace if the build is code-signed with an
// Apple Developer ID *and* notarized — Squirrel.Mac verifies the signature
// before swapping the app. We currently ship UNSIGNED, so on macOS we detect +
// notify and open the GitHub download page instead of installing in place.
//
// The day you add signing, macOS gets the same silent "Restart to update" flow
// as Windows/Linux. To turn it on:
//   1. electron-builder.yml → set `mac.identity` to your "Developer ID
//      Application: …" cert and add notarization (APPLE_ID / APPLE_TEAM_ID /
//      APPLE_APP_SPECIFIC_PASSWORD secrets in CI).
//   2. Flip MAC_SILENT_UPDATE to true here and rebuild.
const MAC_SILENT_UPDATE = false;

// Releases live in this repo (must match electron-builder.yml `publish`).
const REPO = 'DevZonayed/mochi-app';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

export type UpdatePhase =
  | 'idle'        // nothing happening yet
  | 'checking'    // querying the feed
  | 'available'   // newer version exists (mac-unsigned: download is manual)
  | 'none'        // already up to date
  | 'downloading' // pulling the new build in the background
  | 'ready'       // downloaded — restart to install
  | 'error';      // check/download failed

export interface UpdateStatus {
  phase: UpdatePhase;
  /** The version the update refers to (when known). */
  version?: string;
  /** Release notes markdown for `version` (when the feed provides them). */
  notes?: string;
  /** Download progress 0–100 while phase === 'downloading'. */
  percent?: number;
  /** Human-readable error when phase === 'error'. */
  message?: string;
  /** The version currently running. */
  currentVersion: string;
  channel: 'stable' | 'beta';
  /** true on Win/Linux (and signed mac): the app can swap itself on restart. */
  canInstall: boolean;
  /** mac-unsigned: the UI sends users to the download page instead of installing. */
  manualDownload: boolean;
  releasesUrl: string;
  platform: NodeJS.Platform;
}

type Emit = (name: string, data: unknown, opts?: { desktopOnly?: boolean; live?: boolean }) => void;

export class Updater {
  private phase: UpdatePhase = 'idle';
  private version?: string;
  private notesText?: string;
  private percent?: number;
  private message?: string;
  private channel: 'stable' | 'beta' = 'stable';
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Win/Linux always; macOS only when the build is signed. */
  private readonly silent = process.platform !== 'darwin' || MAC_SILENT_UPDATE;

  constructor(private readonly emit: Emit) {
    this.channel = readChannel();

    autoUpdater.autoDownload = this.silent;          // mac-unsigned can't install → don't pull it
    autoUpdater.autoInstallOnAppQuit = this.silent;
    autoUpdater.allowPrerelease = this.channel === 'beta';
    autoUpdater.channel = this.channel === 'beta' ? 'beta' : 'latest';

    autoUpdater.on('checking-for-update', () => this.set('checking'));
    autoUpdater.on('update-available', (info: UpdateInfo) =>
      this.set(this.silent ? 'downloading' : 'available', { version: info.version, notes: notesOf(info), percent: 0 }));
    autoUpdater.on('update-not-available', () => this.set('none'));
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.set('downloading', { percent: Math.max(0, Math.min(100, Math.round(p.percent))) }));
    autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
      this.set('ready', { version: info.version, notes: notesOf(info) }));
    autoUpdater.on('error', (err: Error) =>
      this.set('error', { message: err?.message || 'update failed' }));
  }

  private set(phase: UpdatePhase, extra?: { version?: string; notes?: string; percent?: number; message?: string }): void {
    this.phase = phase;
    if (extra?.version !== undefined) this.version = extra.version;
    if (extra?.notes !== undefined) this.notesText = extra.notes;
    if (extra?.percent !== undefined) this.percent = extra.percent;
    this.message = extra?.message; // cleared on every non-error transition
    this.emit('update', this.status(), { desktopOnly: true });
  }

  status(): UpdateStatus {
    return {
      phase: this.phase,
      version: this.version,
      notes: this.notesText,
      percent: this.percent,
      message: this.message,
      currentVersion: app.getVersion(),
      channel: this.channel,
      canInstall: this.silent,
      manualDownload: !this.silent,
      releasesUrl: RELEASES_URL,
      platform: process.platform,
    };
  }

  /** Query the GitHub feed. No-op in dev unless MAESTRO_TEST_UPDATES=1. */
  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged && process.env.MAESTRO_TEST_UPDATES !== '1') {
      this.set('none'); // dev build: pretend up-to-date rather than throwing
      return this.status();
    }
    try {
      if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.set('error', { message: (e as Error)?.message || 'update check failed' });
    }
    return this.status();
  }

  /** Restart into the new version (Win/Linux + signed mac), or open the
      download page (mac-unsigned). */
  async install(): Promise<{ ok: boolean }> {
    if (!this.silent) { await shell.openExternal(RELEASES_URL); return { ok: true }; }
    // Defer so the IPC reply is sent before the app quits.
    setImmediate(() => { try { autoUpdater.quitAndInstall(); } catch { /* nothing staged */ } });
    return { ok: true };
  }

  async openReleases(): Promise<{ ok: boolean }> { await shell.openExternal(RELEASES_URL); return { ok: true }; }

  async setChannel(channel: 'stable' | 'beta'): Promise<UpdateStatus> {
    this.channel = channel;
    writeChannel(channel);
    autoUpdater.allowPrerelease = channel === 'beta';
    autoUpdater.channel = channel === 'beta' ? 'beta' : 'latest';
    return this.check();
  }

  /** Release notes for any version (the Settings "What's New" button). Pulls
      the published GitHub release body; returns empty notes if offline/missing. */
  async notes(version?: string): Promise<{ version: string; notes: string; url: string }> {
    const v = (version || app.getVersion()).replace(/^v/, '');
    const tag = `v${v}`;
    const url = `https://github.com/${REPO}/releases/tag/${tag}`;
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, {
        headers: { accept: 'application/vnd.github+json' },
      });
      if (r.ok) {
        const j = (await r.json()) as { body?: string };
        return { version: v, notes: j.body || '', url };
      }
    } catch { /* offline or no such release */ }
    return { version: v, notes: this.version === v ? (this.notesText || '') : '', url };
  }

  /** Check shortly after launch, then every 4 hours. */
  start(): void {
    if (this.timer) return;
    setTimeout(() => void this.check(), 8_000);
    this.timer = setInterval(() => void this.check(), 4 * 60 * 60 * 1_000);
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

function notesOf(info: UpdateInfo): string {
  const n = (info as { releaseNotes?: string | Array<{ note?: string | null }> | null }).releaseNotes;
  if (!n) return '';
  if (typeof n === 'string') return n;
  return n.map((x) => x?.note || '').filter(Boolean).join('\n\n');
}

// Channel persists in a tiny file in userData (no dependency on the main store).
function channelPath(): string {
  // app.getPath is only valid after `ready`, which is always true by the time
  // an Updater is constructed in main.ts's whenReady handler.
  return path.join(app.getPath('userData'), 'update-channel');
}
function readChannel(): 'stable' | 'beta' {
  try { return readFileSync(channelPath(), 'utf8').trim() === 'beta' ? 'beta' : 'stable'; }
  catch { return 'stable'; }
}
function writeChannel(channel: 'stable' | 'beta'): void {
  try { writeFileSync(channelPath(), channel); } catch { /* best effort */ }
}
