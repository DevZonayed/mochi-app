/* renameLocalBranch — pure git plumbing. Uses a real temp repo on disk
   (no network), same pattern as the other git.* tests. */

import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo } from './test-helpers.js';
import { renameLocalBranch } from './git.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('renameLocalBranch', () => {
  test('renames the local branch when on `from`', () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'mochi/lyon/lyon');
    writeFileSync(path.join(r, 'a.txt'), '1');
    git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'x');

    const res = renameLocalBranch(r, 'mochi/lyon/lyon', 'mochi/lyon/fix-auth');
    expect(res.ok).toBe(true);
    expect(res.unchanged).toBeUndefined();
    expect(git(r, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('mochi/lyon/fix-auth');
  });

  test('is a no-op when from === to', () => {
    const r = repo();
    const res = renameLocalBranch(r, 'main', 'main');
    expect(res.ok).toBe(true);
    expect(res.unchanged).toBe(true);
  });

  test('reports already-renamed when the worktree is already on `to`', () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'mochi/lyon/fix-auth');
    const res = renameLocalBranch(r, 'mochi/lyon/lyon', 'mochi/lyon/fix-auth');
    expect(res.ok).toBe(true);
    expect(res.unchanged).toBe(true);
  });

  test('refuses when the worktree is on neither from nor to', () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'feature/x');
    const res = renameLocalBranch(r, 'mochi/lyon/lyon', 'mochi/lyon/fix-auth');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/expected/);
  });

  test('refuses when the target name already exists', () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'mochi/lyon/lyon');
    git(r, 'branch', 'mochi/lyon/fix-auth');
    const res = renameLocalBranch(r, 'mochi/lyon/lyon', 'mochi/lyon/fix-auth');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/already exists/);
  });

  test('reports not a repo when run outside git', () => {
    const res = renameLocalBranch('/tmp/definitely-not-a-repo-mst', 'a', 'b');
    expect(res.ok).toBe(false);
  });
});
