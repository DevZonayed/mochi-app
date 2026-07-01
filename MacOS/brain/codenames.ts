/* Per-session codename picker — every session is born with a memorable city
   "callsign" (e.g. "Lyon", "Porto", "Hue"). The codename:
   • becomes a stable segment in the session's git branch (`mochi/<city>/<slug>`),
   • is shown in chat headers & rails so the operator can say "what's Lyon doing?"
     instead of memorizing IDs,
   • is unique within a project at the moment of assignment (cross-project
     repeats are fine — Lyon-in-app-A vs Lyon-in-app-B is intuitive).

   Pure (no fs/electron) so it unit-tests trivially. The list itself is loaded
   once from `codenames.cities.json`. */

import citiesJson from './codenames.cities.json';

/* The curated city list (~280 small-to-medium recognisable cities, lowercase &
   kebab-safe — already valid git branch segments). */
export const CITIES: readonly string[] = Object.freeze([...(citiesJson as string[])]);

/** Pick a codename that doesn't collide with `used`. Deterministic with `seed`
    (so tests don't flake), random otherwise. Falls back to a numeric suffix if
    every city is taken (a 280-session pile-up in one project would be epic). */
export function pickCityCodename(used: ReadonlySet<string>, seed?: number): string {
  const pool = CITIES.filter(c => !used.has(c));
  if (!pool.length) {
    // Fallback — append an incrementing suffix to keep things unique.
    for (let n = 2; n < 1000; n++) {
      for (const c of CITIES) {
        const candidate = `${c}-${n}`;
        if (!used.has(candidate)) return candidate;
      }
    }
    return `mochi-${Date.now().toString(36)}`;
  }
  const idx = typeof seed === 'number' ? Math.abs(seed) % pool.length : Math.floor(Math.random() * pool.length);
  return pool[idx];
}

/** Return the codename in display form (`lyon` → `Lyon`, `chiang-mai` → `Chiang Mai`). */
export function displayCodename(codename: string): string {
  return codename.split('-').map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ');
}

/** Extract the codename segment from a `mochi/<city>/<slug>` branch name. Returns
    null when the branch doesn't follow the convention. */
export function codenameFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const m = /^mochi\/([a-z0-9-]+)\//.exec(branch);
  return m ? m[1] : null;
}
