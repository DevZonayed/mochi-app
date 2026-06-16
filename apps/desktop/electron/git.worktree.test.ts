import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, existsSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { resolveBaseBranch, addWorktree, listWorktrees, removeWorktree, copyGlobsInto, worktreeExists } from './git.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function tmp(): string { const d = makeTempDir(); cleanup.push(d); return d; }

describe('resolveBaseBranch', () => {
  test('falls back to the current branch when there is no origin/HEAD', () => {
    expect(resolveBaseBranch(repo())).toBe('main');
  });
});

describe('addWorktree / listWorktrees / worktreeExists', () => {
  test('creates a new-branch worktree at the path and lists it', () => {
    const r = repo();
    const wt = path.join(tmp(), 'wt1');
    const res = addWorktree(r, wt, 'mochi/test-abcd', 'main');
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
    // git canonicalizes worktree paths (macOS /var -> /private/var), so compare
    // via realpath — not path.resolve, which does not follow symlinks.
    const wtReal = realpathSync(wt);
    const entry = listWorktrees(r).find(w => realpathSync(w.path) === wtReal);
    expect(entry?.branch).toBe('mochi/test-abcd');
    expect(worktreeExists(r, wt)).toBe(true);
  });

  test('reuses an existing branch (no -b)', () => {
    const r = repo();
    execFileSync('git', ['-C', r, 'branch', 'mochi/existing'], { encoding: 'utf8' });
    const res = addWorktree(r, path.join(tmp(), 'wt'), 'mochi/existing', 'main');
    expect(res.ok).toBe(true);
  });

  test('worktreeExists is false for a path that is not a worktree', () => {
    const r = repo();
    expect(worktreeExists(r, path.join(tmp(), 'nope'))).toBe(false);
  });
});

describe('removeWorktree', () => {
  test('removes the worktree dir and the branch when asked', () => {
    const r = repo();
    const wt = path.join(tmp(), 'wt');
    addWorktree(r, wt, 'mochi/gone', 'main');
    const res = removeWorktree(r, wt, { deleteBranch: 'mochi/gone' });
    expect(res.ok).toBe(true);
    expect(existsSync(wt)).toBe(false);
    const branches = execFileSync('git', ['-C', r, 'branch', '--list', 'mochi/gone'], { encoding: 'utf8' });
    expect(branches.trim()).toBe('');
  });
});

describe('copyGlobsInto', () => {
  test('copies matching gitignored files into the destination, skips non-matches', () => {
    const r = repo();
    const dest = tmp();
    writeFileSync(path.join(r, '.env'), 'SECRET=1\n');
    writeFileSync(path.join(r, '.env.local'), 'LOCAL=2\n');
    writeFileSync(path.join(r, 'keep.txt'), 'no\n');
    copyGlobsInto(r, dest, ['.env*']);
    expect(readFileSync(path.join(dest, '.env'), 'utf8')).toContain('SECRET=1');
    expect(readFileSync(path.join(dest, '.env.local'), 'utf8')).toContain('LOCAL=2');
    expect(existsSync(path.join(dest, 'keep.txt'))).toBe(false);
  });
});
