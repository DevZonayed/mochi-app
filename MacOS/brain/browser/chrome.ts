/* Google Chrome lifecycle helpers (macOS). Used by the seed-import flow (close
   Chrome for a clean copy, then reopen) and the "Chrome not installed" path. */
import { execFileSync, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_BIN_SYSTEM = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_BIN_USER = path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/';

export interface ChromeStatus { installed: boolean; path: string | null; version: string | null; running: boolean }

function chromeBinary(): string | null {
  if (existsSync(CHROME_BIN_SYSTEM)) return CHROME_BIN_SYSTEM;
  if (existsSync(CHROME_BIN_USER)) return CHROME_BIN_USER;
  return null;
}

/** True iff the main "Google Chrome" process is running (helpers don't count). */
export function isChromeRunning(): boolean {
  try { execFileSync('/usr/bin/pgrep', ['-x', 'Google Chrome'], { stdio: 'ignore' }); return true; }
  catch { return false; } // pgrep exits non-zero when there's no match
}

export function chromeStatus(): ChromeStatus {
  const bin = chromeBinary();
  let version: string | null = null;
  if (bin) { try { version = execFileSync(bin, ['--version'], { timeout: 5000 }).toString().trim() || null; } catch { /* */ } }
  return { installed: !!bin, path: bin, version, running: isChromeRunning() };
}

/** Graceful quit (equivalent to Cmd+Q — Chrome flushes its DBs and restores the
    session on next launch), then wait for the process to actually exit. Returns
    false if it couldn't be closed (e.g. a beforeunload dialog blocked the quit). */
export async function quitChrome(timeoutMs = 12000): Promise<boolean> {
  if (!isChromeRunning()) return true;
  try { execFileSync('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to quit'], { timeout: 8000 }); }
  catch { /* a page dialog may block; we still poll below */ }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isChromeRunning()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !isChromeRunning();
}

export function reopenChrome(): void {
  try { execFile('/usr/bin/open', ['-a', 'Google Chrome'], () => { /* fire-and-forget */ }); } catch { /* */ }
}

/** Open Google's official Chrome download page in the user's default browser. */
export function openChromeDownload(): void {
  try { execFile('/usr/bin/open', [CHROME_DOWNLOAD_URL], () => { /* */ }); } catch { /* */ }
}
