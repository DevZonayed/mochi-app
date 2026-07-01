import { describe, test, expect, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { ensureSessionWorktree, pruneSessionWorktree } from './session-worktree.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function tmp(): string { const d = makeTempDir(); cleanup.push(d); return d; }

describe('ensureSessionWorktree', () => {
  test('creates a worktree at root/projectId/sessionId and copies gitignored files', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    writeFileSync(path.join(repoDir, '.env'), 'X=1\n');
    const res = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12', copyGlobs: ['.env*'] });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(res.cwd).toBe(path.join(worktreeRoot, 'p1', 's1'));
    expect(existsSync(path.join(res.cwd, 'README.md'))).toBe(true);
    expect(existsSync(path.join(res.cwd, '.env'))).toBe(true);
  });

  test('is idempotent — a second call resolves the same worktree without recreating', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    const first = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12' });
    const second = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
  });

  test('runs the setup script when provided', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    const runSetup = vi.fn();
    ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's2', branch: 'mochi/foo-cd34', setupScript: 'echo hi', runSetup });
    expect(runSetup).toHaveBeenCalledOnce();
  });

  test('returns ok:false and falls back to the repo dir when the path is not a git repo', () => {
    const notRepo = tmp(); const worktreeRoot = tmp();
    const res = ensureSessionWorktree({ repoDir: notRepo, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/x-0000' });
    expect(res.ok).toBe(false);
    expect(res.cwd).toBe(notRepo);
  });
});

describe('pruneSessionWorktree', () => {
  test('removes the session worktree directory', () => {
    const repoDir = repo(); const worktreeRoot = tmp();
    const r = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12' });
    expect(existsSync(r.cwd)).toBe(true);
    const pr = pruneSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's1', branch: 'mochi/foo-ab12', deleteBranch: true });
    expect(pr.ok).toBe(true);
    expect(existsSync(r.cwd)).toBe(false);
  });
});
