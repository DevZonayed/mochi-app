/* The ONE canonical project-file resolver — shared by the localApi file arms
   (`readFile`/`writeFile`/`listDir`) and the sidecar stream route, so path
   confinement lives in exactly one place. Ported from the Electron-only
   `resolveInsideRoot`/`rootsFor` helpers in localApi.ts and extended with a
   whole-path-segment suffix fallback for chat links that carry a bare
   `renders/final.mp4`-style relative path.

   Confinement contract (unchanged from the original): resolve against a realpath'd
   root, block `..` escapes by path math, and — if the target exists — realpath it
   and re-check it still lands inside the root (defeats symlink escapes). */

import { existsSync, realpathSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';

/** Minimal structural view of the Store the resolver needs — kept structural so
    file-resolve stays decoupled from the concrete Store class. */
export interface ResolveStore {
  getProject(projectId: string): { path?: string } | undefined;
  getSession(sessionId: string): { projectId?: string; worktreePath?: string } | undefined;
  listSessions(): Array<{ projectId?: string; worktreePath?: string }>;
}

const escapeError = (): Error => Object.assign(new Error('path escapes project'), { code: 'escape' });
const escapesParent = (rel: string): boolean =>
  rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel);

/** Expand a leading `~/` (or a bare `~`) to the home directory, like the original
    `resolveInsideRoot` did for the root. */
const expandTilde = (p: string): string => (p === '~' || p.startsWith('~/') ? nodePath.join(homedir(), p.slice(1)) : p);

/* ── Skip/walk caps for the suffix fallback. ─────────────────────────────── */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.build', '.next']);
const SCAN_CAP = 20000; // hard cap on entries scanned per root
const MAX_DEPTH = 12;   // directory-depth cap

/**
 * Resolve `rel` (relative OR absolute) against `root` and return a canonical
 * absolute path that is provably INSIDE `root`.
 *
 * - Blocks `..` escapes by path math BEFORE requiring the target to exist, so a
 *   not-yet-created path (still inside the root) resolves cleanly.
 * - If the target exists, realpath it and re-check — a symlink that points out of
 *   the root is rejected.
 * - Throws an `Error` whose `.code === 'escape'` on any escape.
 */
export function confineToRoot(rawRoot: string, rel: string): string {
  const rootReal = realpathSync(nodePath.resolve(expandTilde(rawRoot)));
  const relExpanded = expandTilde(String(rel ?? ''));
  const target = nodePath.resolve(rootReal, relExpanded);
  const relToRoot = nodePath.relative(rootReal, target);
  if (escapesParent(relToRoot)) throw escapeError();
  if (!existsSync(target)) return target; // path math already proved it is inside
  const real = realpathSync(target);
  const relReal = nodePath.relative(rootReal, real);
  if (escapesParent(relReal)) throw escapeError();
  return real;
}

/**
 * Candidate roots for a file RPC, in priority order (moved here verbatim from
 * localApi's `rootsFor` so there is a single definition):
 *   1. the ACTIVE session's worktree (when a sessionId is passed),
 *   2. the project root,
 *   3. every other session worktree of the project.
 * Non-existent worktrees are filtered out. Throws if the project has no folder.
 */
export function rootsForProject(store: ResolveStore, projectId: unknown, sessionId?: unknown): string[] {
  const pid = String(projectId);
  const roots: string[] = [];
  const sid = sessionId == null ? '' : String(sessionId);
  if (sid) {
    const s = store.getSession(sid);
    if (s && s.projectId === pid && s.worktreePath && existsSync(s.worktreePath)) roots.push(s.worktreePath);
  }
  const proj = store.getProject(pid)?.path;
  if (proj && !roots.includes(proj)) roots.push(proj);
  for (const s of store.listSessions()) {
    if (s.projectId === pid && s.worktreePath && existsSync(s.worktreePath) && !roots.includes(s.worktreePath)) roots.push(s.worktreePath);
  }
  if (!roots.length) throw new Error('this project has no folder on disk');
  return roots;
}

/** True when `pathSegs` ends with `wantSegs` on WHOLE path-segment boundaries
    (so `renders/final.mp4` matches `…/renders/final.mp4` but NOT `…/xrenders/final.mp4`). */
function endsWithSegments(pathSegs: string[], wantSegs: string[]): boolean {
  if (wantSegs.length === 0 || wantSegs.length > pathSegs.length) return false;
  for (let i = 1; i <= wantSegs.length; i++) {
    if (pathSegs[pathSegs.length - i] !== wantSegs[wantSegs.length - i]) return false;
  }
  return true;
}

/** Bounded walk of `rootReal` collecting files whose project-relative path ends
    with `wantSegs` on segment boundaries. Skips vendor/build dirs; caps entries
    scanned and depth so even huge repos stay bounded. */
function suffixMatches(rootReal: string, wantSegs: string[]): string[] {
  const matches: string[] = [];
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || scanned >= SCAN_CAP) return;
    let dirents;
    try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (scanned >= SCAN_CAP) return;
      scanned++;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        walk(nodePath.join(dir, d.name), depth + 1);
      } else if (d.isFile()) {
        const full = nodePath.join(dir, d.name);
        const segs = nodePath.relative(rootReal, full).split(nodePath.sep);
        if (endsWithSegments(segs, wantSegs)) matches.push(full);
      }
    }
  };
  walk(rootReal, 0);
  return matches;
}

/**
 * Resolve a project file across `roots` in priority order, NEVER escaping any root.
 *
 * (a) DIRECT — for each root, `confineToRoot`; if the confined path EXISTS, return it.
 * (b) SUFFIX FALLBACK (only when `rel` is not absolute / not `~`-anchored and no
 *     direct hit) — within the FIRST root that yields ≥1 whole-segment suffix match:
 *     exactly 1 → return it (re-confined); >1 → throw `.code==='ambiguous'`. A root
 *     with 0 matches falls through to the next root.
 * (c) none anywhere → throw `.code==='not-found'`.
 */
export function resolveProjectFile(roots: string[], rel: string): string {
  const relStr = String(rel ?? '');

  // (a) DIRECT resolution against each root in priority order.
  let escape: Error | null = null;
  for (const root of roots) {
    let confined: string;
    try {
      confined = confineToRoot(root, relStr);
    } catch (err) {
      if ((err as { code?: string })?.code === 'escape') escape = err instanceof Error ? err : escapeError();
      continue;
    }
    if (existsSync(confined)) return confined;
  }
  if (escape) throw escape;

  // (b) SUFFIX FALLBACK — absolute / `~`-anchored inputs are addressed directly, never scanned.
  const absoluteLike = nodePath.isAbsolute(relStr) || relStr === '~' || relStr.startsWith('~/');
  if (!absoluteLike) {
    const wantSegs = relStr.split('/').filter(Boolean);
    if (wantSegs.length) {
      for (const root of roots) {
        let rootReal: string;
        try { rootReal = realpathSync(nodePath.resolve(expandTilde(root))); } catch { continue; }
        const matches = suffixMatches(rootReal, wantSegs);
        if (matches.length === 1) {
          return confineToRoot(root, nodePath.relative(rootReal, matches[0]));
        }
        if (matches.length > 1) throw Object.assign(new Error('ambiguous path'), { code: 'ambiguous' });
        // 0 matches in this root → try the next one
      }
    }
  }

  // (c) nothing matched anywhere.
  throw Object.assign(new Error('file not found in project'), { code: 'not-found' });
}
