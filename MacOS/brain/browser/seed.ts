/* "Golden seed profile" — copy login state from ONE chosen real Chrome profile into
   a Mochi-owned seed, then start each project's isolated browser FROM that seed so it
   begins signed in (and then diverges independently).

   Safety: the real profile is only READ. Cookies are snapshotted with sqlite3's online
   `.backup` (a consistent copy even while Chrome is open), so the user never has to
   quit Chrome, and the real profile is never launched, locked, or written. The copy
   decrypts because it runs on the SAME Mac/Keychain (v10 cookies, keychain-derived) —
   which is also why the browser must launch WITHOUT `--use-mock-keychain` (see manager.ts). */
import path from 'node:path';
import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { browserProfilesRoot, browserProfileDir } from './paths.js';
import { CHROME_DIR } from './profiles.js';

export interface SeedInfo { sourceDir: string; sourceName: string; importedAt: number; cookieCount: number }

const SQLITE = '/usr/bin/sqlite3';
function seedDir(userDataDir: string): string { return path.join(browserProfilesRoot(userDataDir), '_seed'); }
function seedMarker(userDataDir: string): string { return path.join(seedDir(userDataDir), '.mochi-seed.json'); }

export function hasSeed(userDataDir: string): boolean { return existsSync(seedMarker(userDataDir)); }
export function seedInfo(userDataDir: string): SeedInfo | null {
  try { return JSON.parse(readFileSync(seedMarker(userDataDir), 'utf8')) as SeedInfo; } catch { return null; }
}
export function clearSeed(userDataDir: string): void { rmSync(seedDir(userDataDir), { recursive: true, force: true }); }

/** Import login state from a real Chrome profile dir ('Default' | 'Profile N') into
    the global seed. Read-only on the real profile. Returns what was captured. */
export function importSeed(userDataDir: string, profileDir: string, sourceName?: string): SeedInfo {
  const src = path.join(CHROME_DIR, profileDir);
  if (!existsSync(src)) throw Object.assign(new Error(`Chrome profile not found: ${profileDir}`), { statusCode: 404 });
  const dest = path.join(seedDir(userDataDir), 'Default');
  rmSync(seedDir(userDataDir), { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  // Cookies — the primary login mechanism. Online .backup = consistent snapshot even
  // while Chrome is running. The source path may contain spaces ("Application Support")
  // — execFileSync passes argv literally (no shell), and the dest is single-quoted in
  // the dot-command so sqlite handles its spaces too.
  let cookieCount = 0;
  const cookiesSrc = path.join(src, 'Cookies');
  if (existsSync(cookiesSrc)) {
    const destCookies = path.join(dest, 'Cookies');
    execFileSync(SQLITE, [cookiesSrc, `.backup '${destCookies}'`], { stdio: 'ignore' });
    try { cookieCount = Number(execFileSync(SQLITE, [destCookies, 'select count(*) from cookies;']).toString().trim()) || 0; } catch { /* */ }
  }
  // Local Storage (best-effort — some sites keep auth tokens here). A live copy may be
  // slightly stale; worst case those sites just need a re-login. Never fatal.
  const lsSrc = path.join(src, 'Local Storage');
  if (existsSync(lsSrc)) { try { cpSync(lsSrc, path.join(dest, 'Local Storage'), { recursive: true }); } catch { /* */ } }

  const info: SeedInfo = { sourceDir: profileDir, sourceName: sourceName || profileDir, importedAt: Date.now(), cookieCount };
  writeFileSync(seedMarker(userDataDir), JSON.stringify(info, null, 2));
  return info;
}

/** Before a project's browser is first launched: if it has no profile yet AND a seed
    exists, copy the seed into the project's own dir so it starts signed in. Each
    project keeps its OWN copy that then diverges. Never overwrites an existing profile. */
export function applySeedIfFresh(userDataDir: string, projectId: string): boolean {
  const proj = browserProfileDir(userDataDir, projectId);
  if (existsSync(proj)) return false;            // project already has its own profile
  if (!hasSeed(userDataDir)) return false;       // nothing to seed from
  try {
    const seedDefault = path.join(seedDir(userDataDir), 'Default');
    if (!existsSync(seedDefault)) return false;
    mkdirSync(path.join(proj, 'Default'), { recursive: true });
    cpSync(seedDefault, path.join(proj, 'Default'), { recursive: true });
    return true;
  } catch { return false; }
}
