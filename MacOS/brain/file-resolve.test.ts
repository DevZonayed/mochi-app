/* The ONE canonical project-file resolver: priority-ordered roots (active
   session worktree → project root → other worktrees), DIRECT resolution, then a
   whole-path-segment SUFFIX fallback — all funneled through the same realpath +
   `..` + symlink-escape confinement the Electron file arms used. Verified against
   real temp dirs (mkdtempSync) so the confinement and walk semantics are exercised
   for real, not mocked. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { confineToRoot, resolveProjectFile, rootsForProject } from './file-resolve.js';

let base: string;
const touch = (p: string) => { mkdirSync(nodePath.dirname(p), { recursive: true }); writeFileSync(p, 'x'); };

beforeEach(() => { base = realpathSync(mkdtempSync(nodePath.join(tmpdir(), 'maestro-fr-'))); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('confineToRoot — realpath + `..` + symlink-escape confinement', () => {
  it('accepts a relative path inside the root and returns the canonical path', () => {
    touch(nodePath.join(base, 'src', 'a.ts'));
    expect(confineToRoot(base, 'src/a.ts')).toBe(nodePath.join(base, 'src', 'a.ts'));
  });

  it('accepts an absolute path that lands inside the root', () => {
    const abs = nodePath.join(base, 'src', 'a.ts');
    touch(abs);
    expect(confineToRoot(base, abs)).toBe(abs);
  });

  it('resolves `..` by path math BEFORE requiring existence, and returns a non-existent inside path', () => {
    // target does not exist yet, but is provably inside → returned as canonical abs
    const out = confineToRoot(base, 'does/not/exist.txt');
    expect(out).toBe(nodePath.join(base, 'does/not/exist.txt'));
  });

  it('rejects a `..` traversal with code=escape', () => {
    let err: any;
    try { confineToRoot(base, '../outside.txt'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('escape');
  });

  it('accepts path segments that merely start with `..` but do not traverse', () => {
    const file = nodePath.join(base, '..foo', 'config.json');
    touch(file);
    expect(confineToRoot(base, '..foo/config.json')).toBe(file);
  });

  it('rejects an absolute path OUTSIDE the root with code=escape', () => {
    let err: any;
    try { confineToRoot(base, '/etc/hosts'); } catch (e) { err = e; }
    expect(err?.code).toBe('escape');
  });

  it('rejects a symlink that escapes the root with code=escape', () => {
    const outside = realpathSync(mkdtempSync(nodePath.join(tmpdir(), 'maestro-out-')));
    try {
      writeFileSync(nodePath.join(outside, 'secret.txt'), 'top');
      symlinkSync(nodePath.join(outside, 'secret.txt'), nodePath.join(base, 'link.txt'));
      let err: any;
      try { confineToRoot(base, 'link.txt'); } catch (e) { err = e; }
      expect(err?.code).toBe('escape');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

describe('resolveProjectFile — priority + direct + suffix fallback', () => {
  it('DIRECT: the active-session worktree wins over the project root for the same relpath', () => {
    const wt = nodePath.join(base, 'wt'); const proj = nodePath.join(base, 'proj');
    touch(nodePath.join(wt, 'shared.txt'));
    touch(nodePath.join(proj, 'shared.txt'));
    expect(resolveProjectFile([wt, proj], 'shared.txt')).toBe(nodePath.join(wt, 'shared.txt'));
  });

  it('SUFFIX: a unique nested match resolves on whole-segment boundaries (not a xrenders decoy)', () => {
    const good = nodePath.join(base, 'projects', 'openmontage-tutorial', 'renders', 'final.mp4');
    touch(good);
    touch(nodePath.join(base, 'other', 'xrenders', 'final.mp4')); // must NOT match `renders/final.mp4`
    expect(resolveProjectFile([base], 'renders/final.mp4')).toBe(good);
  });

  it('SUFFIX: two nested matches within a root throw code=ambiguous', () => {
    touch(nodePath.join(base, 'a', 'renders', 'final.mp4'));
    touch(nodePath.join(base, 'b', 'renders', 'final.mp4'));
    let err: any;
    try { resolveProjectFile([base], 'renders/final.mp4'); } catch (e) { err = e; }
    expect(err?.code).toBe('ambiguous');
  });

  it('no match anywhere throws code=not-found', () => {
    touch(nodePath.join(base, 'a.txt'));
    let err: any;
    try { resolveProjectFile([base], 'nope/missing.mp4'); } catch (e) { err = e; }
    expect(err?.code).toBe('not-found');
  });

  it('does NOT suffix-scan skipped dirs (node_modules/.git/dist)', () => {
    touch(nodePath.join(base, 'node_modules', 'pkg', 'renders', 'final.mp4'));
    let err: any;
    try { resolveProjectFile([base], 'renders/final.mp4'); } catch (e) { err = e; }
    expect(err?.code).toBe('not-found');
  });

  it('an absolute path inside a root resolves directly', () => {
    const abs = nodePath.join(base, 'deep', 'x.txt');
    touch(abs);
    expect(resolveProjectFile([base], abs)).toBe(abs);
  });

  it('an absolute path outside every root is rejected (never escapes)', () => {
    touch(nodePath.join(base, 'a.txt'));
    let err: any;
    try { resolveProjectFile([base], '/etc/hosts'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('escape');
  });

  it('preserves escape classification across candidate roots', () => {
    const wt = nodePath.join(base, 'wt'); const proj = nodePath.join(base, 'proj');
    mkdirSync(wt, { recursive: true });
    mkdirSync(proj, { recursive: true });
    let err: any;
    try { resolveProjectFile([wt, proj], '../outside.txt'); } catch (e) { err = e; }
    expect(err?.code).toBe('escape');
  });
});

describe('rootsForProject — priority order from the store', () => {
  it('active worktree first, then project root, then other worktrees; existsSync-filtered', () => {
    const proj = nodePath.join(base, 'proj'); mkdirSync(proj, { recursive: true });
    const wtA = nodePath.join(base, 'wtA'); mkdirSync(wtA, { recursive: true });
    const wtB = nodePath.join(base, 'wtB'); mkdirSync(wtB, { recursive: true });
    const store = {
      getProject: (id: string) => (id === 'p1' ? { path: proj } : undefined),
      getSession: (id: string) => (id === 'sA' ? { projectId: 'p1', worktreePath: wtA } : undefined),
      listSessions: () => [
        { projectId: 'p1', worktreePath: wtA },
        { projectId: 'p1', worktreePath: wtB },
        { projectId: 'p2', worktreePath: nodePath.join(base, 'gone') }, // other project, ignored
      ],
    };
    expect(rootsForProject(store as any, 'p1', 'sA')).toEqual([wtA, proj, wtB]);
    expect(rootsForProject(store as any, 'p1')).toEqual([proj, wtA, wtB]);
  });

  it('throws when the project has no folder on disk', () => {
    const store = { getProject: () => undefined, getSession: () => undefined, listSessions: () => [] };
    expect(() => rootsForProject(store as any, 'nope')).toThrow();
  });
});
