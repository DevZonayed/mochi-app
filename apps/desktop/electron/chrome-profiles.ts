/* Reading the user's installed Chrome profiles so they can pick one in Settings.
   Picking a profile makes the browser launch the REAL Chrome user-data-dir +
   --profile-directory, so it inherits that profile's cookies, history, logins and
   bot-trust (no more "I am not a robot" on a contextless browser). We only ever
   read the profile NAMES from Local State — never cookies, passwords, or history. */

import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ChromeProfile { dir: string; name: string }

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
