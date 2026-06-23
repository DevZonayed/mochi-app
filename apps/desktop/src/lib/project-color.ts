/* project-color — pick a CSS color var for a project.
 *
 * Projects carry a free-form `color` string ("blue", "purple", …) that the UI
 * maps to a `var(--<color>)` design token. New projects default to "blue", but
 * older/imported ones can be missing the field. To keep the tab strip's
 * project grouping (Track 6) visually distinguishable even without explicit
 * colors, we derive a stable color from the project id via a small palette.
 *
 * Stable means: same id → same color across reloads and across machines, so
 * the colored left-stripe never jumps around as projects come and go.
 */

import type { Project } from './api';

/** Available palette tokens defined in packages/design-tokens/src/tokens.css. */
export const PROJECT_PALETTE = ['blue', 'green', 'purple', 'orange', 'teal', 'indigo', 'red'] as const;
export type ProjectPaletteColor = typeof PROJECT_PALETTE[number];

/** djb2 — small, fast, deterministic. Sufficient for spreading ~handful of ids. */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Pick a palette color from an id (deterministic). */
export function colorFromId(id: string): ProjectPaletteColor {
  if (!id) return 'blue';
  return PROJECT_PALETTE[hashString(id) % PROJECT_PALETTE.length];
}

/** Resolve a project's color token name — stored value, falling back to id-hash. */
export function projectColorName(p: Pick<Project, 'id' | 'color'> | null | undefined): ProjectPaletteColor | string {
  if (!p) return 'blue';
  if (p.color) return p.color;
  return colorFromId(p.id);
}

/** CSS `var(--<color>)` string for a project. Safe with missing project. */
export function projectColor(p: Pick<Project, 'id' | 'color'> | null | undefined): string {
  return `var(--${projectColorName(p)})`;
}
