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

export interface SeedInfo {
  sourceDir: string;
  sourceName: string;
  importedAt: number;
  cookieCount: number;
  /** True when the source Chrome encrypts cookies with App-Bound Encryption (v20).
      Those cookies can only be unwrapped by Google Chrome itself, so the automation
      Chromium that runs the project browsers can't decrypt them — the seed copies but
      the sites stay logged out. This is the #1 "import worked on one Mac but not
      another" cause and it tracks the installed Chrome version, not the user. */
  appBound?: boolean;
  /** Non-fatal problems worth showing the operator (0 cookies, app-bound cookies,
      Local Storage copy failed, …). Empty/absent means a clean import. */
  warnings?: string[];
}

const SQLITE = '/usr/bin/sqlite3';
/** ASCII prefixes Chrome stamps on an encrypted cookie value, as sqlite `hex()` output.
    v10/v11 = macOS-Keychain-derived (the automation Chromium CAN decrypt these on the
    same Mac). v20 = App-Bound Encryption (only Google Chrome can unwrap it). */
const HEX_V10 = '763130', HEX_V11 = '763131', HEX_V20 = '763230';

function sqlite(args: string[]): string {
  return execFileSync(SQLITE, args, { timeout: 15000 }).toString();
}

export interface CookieProbe { cookieCount: number; appBound: boolean; warnings: string[] }

/** Inspect a snapshotted Cookies DB: how many cookies it holds and whether they use
    App-Bound Encryption (v20) the agent browser can't decrypt. Exported so the
    diagnostics are unit-testable against a real sqlite fixture (importSeed itself is
    tied to the user's ~/Library Chrome dir). Best-effort: probe failures downgrade to
    an empty result rather than throwing. */
export function probeCookies(destCookies: string): CookieProbe {
  const warnings: string[] = [];
  let cookieCount = 0;
  let appBound = false;
  try { cookieCount = Number(sqlite([destCookies, 'select count(*) from cookies;']).trim()) || 0; } catch { /* handled below */ }
  if (cookieCount === 0) {
    warnings.push('The snapshot captured 0 cookies — the seeded browser will start logged out. Make sure you picked the profile you actually use.');
    return { cookieCount, appBound, warnings };
  }
  // App-Bound Encryption detection — the real machine-to-machine differentiator.
  // v20-prefixed cookies can't be unwrapped by the automation Chromium, so the import
  // "succeeds" yet every site is logged out on affected Macs.
  try {
    const kinds = sqlite([destCookies, `select distinct hex(substr(encrypted_value,1,3)) from cookies where length(encrypted_value) >= 3;`])
      .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
    appBound = kinds.includes(HEX_V20);
    const decryptable = kinds.some(k => k === HEX_V10 || k === HEX_V11);
    if (appBound) {
      warnings.push(decryptable
        ? 'Some cookies use App-Bound Encryption (v20); those logins may not carry over. If a site is still logged out, sign in once inside the project browser.'
        : 'This Chrome uses App-Bound Encryption (v20 cookies), which the agent browser cannot decrypt — the seed will start logged out. Sign in once inside the project browser instead.');
    }
  } catch { /* prefix probe is best-effort diagnostics only */ }
  return { cookieCount, appBound, warnings };
}
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
  // Snapshotting cookies REQUIRES sqlite3. It ships with macOS at /usr/bin/sqlite3,
  // but fail loudly rather than silently importing an empty (logged-out) seed.
  if (!existsSync(SQLITE)) {
    throw Object.assign(new Error('sqlite3 not found at /usr/bin/sqlite3 — cannot snapshot Chrome cookies on this Mac.'), { statusCode: 500 });
  }
  const dest = path.join(seedDir(userDataDir), 'Default');
  rmSync(seedDir(userDataDir), { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const warnings: string[] = [];
  let cookieCount = 0;
  let appBound = false;

  // Cookies — the primary login mechanism. Online .backup = consistent snapshot even
  // while Chrome is running. The source path may contain spaces ("Application Support")
  // — execFileSync passes argv literally (no shell), and the dest is single-quoted in
  // the dot-command so sqlite handles its spaces too.
  const cookiesSrc = path.join(src, 'Cookies');
  if (!existsSync(cookiesSrc)) {
    warnings.push(`No Cookies database in "${profileDir}" — nothing to sign in from.`);
  } else {
    const destCookies = path.join(dest, 'Cookies');
    // Surface a failed snapshot instead of swallowing it (was `stdio: 'ignore'`): a
    // locked/corrupt DB or an sqlite that can't open a newer schema is a real,
    // machine-specific failure the operator needs to see.
    try {
      execFileSync(SQLITE, [cookiesSrc, `.backup '${destCookies}'`], { timeout: 15000 });
    } catch (e) {
      throw Object.assign(new Error(`Could not snapshot Chrome cookies (sqlite3 .backup failed): ${(e as Error).message}`), { statusCode: 500 });
    }
    const probe = probeCookies(destCookies);
    cookieCount = probe.cookieCount;
    appBound = probe.appBound;
    warnings.push(...probe.warnings);
  }
  // Local Storage (best-effort — some sites keep auth tokens here). A live copy may be
  // slightly stale; worst case those sites just need a re-login. Never fatal, but note it.
  const lsSrc = path.join(src, 'Local Storage');
  if (existsSync(lsSrc)) {
    try { cpSync(lsSrc, path.join(dest, 'Local Storage'), { recursive: true }); }
    catch { warnings.push('Local Storage could not be copied — sites that keep tokens there may need a re-login.'); }
  }

  const info: SeedInfo = {
    sourceDir: profileDir, sourceName: sourceName || profileDir, importedAt: Date.now(),
    cookieCount, appBound, ...(warnings.length ? { warnings } : {}),
  };
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
