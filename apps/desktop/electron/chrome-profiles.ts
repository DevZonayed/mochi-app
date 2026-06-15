/* Reading the user's installed Chrome profiles so they can pick one in Settings.
   listChromeProfiles() reads ONLY the profile names from Local State. A chosen
   profile is then used in one of two ways (Settings → Browser → "How to use it"):
   - Copy: importChromeCookies() decrypts that profile's cookies and injects them
     into Maestro's OWN browser — signed in, but the real Chrome is never opened.
   - Live: the browser launches the real Chrome profile directly (engine side). */

import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { createHash, pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface ChromeProfile { dir: string; name: string }
/** A cookie shaped for Playwright's context.addCookies(). */
export interface ImportedCookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean }

/** ~/Library/Application Support/Google/Chrome — the real Chrome user-data-dir. */
export function chromeUserDataDir(): string {
  return path.join(app.getPath('home'), 'Library', 'Application Support', 'Google', 'Chrome');
}

/** The user's Chrome profiles (directory + display name), or [] if Chrome isn't
    installed. Reads ONLY the profile names from Local State. */
export function listChromeProfiles(): ChromeProfile[] {
  try {
    const root = chromeUserDataDir();
    const ls = path.join(root, 'Local State');
    if (!existsSync(ls)) return [];
    const data = JSON.parse(readFileSync(ls, 'utf8')) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    const cache = data.profile?.info_cache ?? {};
    return Object.entries(cache)
      .filter(([dir]) => existsSync(path.join(root, dir)))
      .map(([dir, info]) => ({ dir, name: (info && typeof info.name === 'string' && info.name) || dir }))
      .sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.name.localeCompare(b.name)));
  } catch { return []; }
}

/* ── Copy mode: decrypt a Chrome profile's cookies and inject them into Maestro's
   OWN browser, so it starts signed in WITHOUT ever launching the user's real
   Chrome. On macOS, cookies are AES-encrypted with a key in the login Keychain;
   merely copying the files (the old approach) couldn't carry logins. Here we read
   that key (one Keychain "Allow" prompt), decrypt each cookie, and hand them to
   Playwright as plaintext. Entirely read-only on the real profile; any failure
   degrades to "no cookies" (an isolated browser), never an error. ───────────── */

/** The AES key Chrome uses for cookie encryption on macOS, derived from the
    "Chrome Safe Storage" Keychain password. null if it can't be read. */
function chromeCookieKey(): Buffer | null {
  try {
    const pw = execFileSync('/usr/bin/security', ['find-generic-password', '-wa', 'Chrome', '-s', 'Chrome Safe Storage'],
      { encoding: 'utf8', timeout: 30_000 }).trim();
    if (!pw) return null;
    return pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1'); // Chrome's fixed salt/iterations
  } catch { return null; }
}

/** Read + decrypt all cookies from a Chrome profile into Playwright cookie objects.
    Best-effort: returns [] on any problem (no Chrome, locked DB, denied Keychain). */
export function importChromeCookies(profileDir: string): ImportedCookie[] {
  try {
    const root = chromeUserDataDir();
    const db = [path.join(root, profileDir, 'Network', 'Cookies'), path.join(root, profileDir, 'Cookies')].find(p => existsSync(p));
    if (!db) return [];
    const key = chromeCookieKey();
    if (!key) return [];
    // Copy the (Chrome-locked) SQLite out, then read it with the system sqlite3.
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'mst-ck-'));
    const tmpDb = path.join(tmpDir, 'Cookies');
    let rows = '';
    try {
      copyFileSync(db, tmpDb);
      rows = execFileSync('/usr/bin/sqlite3', ['-readonly', '-separator', '\x1f', tmpDb,
        'SELECT host_key, name, hex(encrypted_value), path, expires_utc, is_secure, is_httponly FROM cookies'],
        { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, timeout: 20_000 });
    } finally { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* gone */ } }

    const iv = Buffer.alloc(16, 0x20); // 16 spaces
    const out: ImportedCookie[] = [];
    for (const line of rows.split('\n')) {
      if (!line) continue;
      const [host, name, hexEnc, cpath, expires, secure, httponly] = line.split('\x1f');
      if (!host || hexEnc === undefined) continue;
      let value: string | null = null;
      try {
        const enc = Buffer.from(hexEnc, 'hex');
        if (enc.length >= 3 && enc.slice(0, 3).toString('latin1') === 'v10') {
          const dc = createDecipheriv('aes-128-cbc', key, iv);
          let dec = Buffer.concat([dc.update(enc.slice(3)), dc.final()]);
          // Newer Chrome prepends sha256(host_key) (32 bytes) to bind the cookie.
          if (dec.length >= 32 && dec.slice(0, 32).equals(createHash('sha256').update(host).digest())) dec = dec.slice(32);
          value = dec.toString('utf8');
        } else if (enc.length) {
          value = enc.toString('utf8'); // unencrypted (rare)
        }
      } catch { value = null; }
      if (value === null || !name) continue; // Playwright needs a non-empty name
      // Chrome expires_utc = microseconds since 1601-01-01; 0 = session cookie.
      const e = Number(expires);
      const exp = e > 0 ? Math.floor(e / 1e6 - 11_644_473_600) : -1;
      out.push({ name: name ?? '', value, domain: host, path: cpath || '/', expires: exp, httpOnly: httponly === '1', secure: secure === '1' });
    }
    return out;
  } catch { return []; }
}
