/* Enumerate the user's REAL Google Chrome profiles (read-only) so the Settings UI
   can offer them as a seed source. We only ever READ Chrome's `Local State` for the
   display-name map — we never open, lock, or write the real profiles. */
import path from 'node:path';
import os from 'node:os';
import { readFileSync, existsSync } from 'node:fs';

export const CHROME_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

export interface ChromeProfile { dir: string; name: string }

/** The installed Chrome's profiles as `{ dir: 'Default'|'Profile N', name }`,
    sorted by display name. Empty array if Chrome isn't installed. */
export function listChromeProfiles(): ChromeProfile[] {
  try {
    const ls = JSON.parse(readFileSync(path.join(CHROME_DIR, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    const cache = ls.profile?.info_cache ?? {};
    const out: ChromeProfile[] = [];
    for (const [dir, v] of Object.entries(cache)) {
      if (existsSync(path.join(CHROME_DIR, dir))) out.push({ dir, name: v?.name || dir });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch { return []; }
}
