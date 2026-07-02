import { describe, test, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { ensureSessionWorktree, pruneSessionWorktree } from './session-worktree.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

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

  test('forks from origin/<base> (freshly fetched), not a backdated local base branch', () => {
    // origin has main @ commit A; a clone advances origin to commit B while the
    // clone's LOCAL main stays at A. A new session worktree must start at B —
    // the local main can be arbitrarily stale (the operator rarely pulls it).
    const origin = repo(); const clone = tmp(); const worktreeRoot = tmp();
    git(origin, 'clone', '-q', origin, path.join(clone, 'co'));
    const co = path.join(clone, 'co');
    git(co, 'config', 'user.email', 'test@local');
    git(co, 'config', 'user.name', 'Test');
    // Advance the ORIGIN past the clone's local main.
    writeFileSync(path.join(origin, 'NEW.md'), 'fresh on origin\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'newer on origin');
    const originSha = git(origin, 'rev-parse', 'HEAD');
    const staleLocalSha = git(co, 'rev-parse', 'main');
    expect(staleLocalSha).not.toBe(originSha);

    const res = ensureSessionWorktree({ repoDir: co, worktreeRoot, projectId: 'p1', sessionId: 's9', branch: 'mochi/fresh-ee99', base: 'main', fetch: true });
    expect(res.ok).toBe(true);
    expect(res.base).toBe('main'); // persisted base stays the SHORT name
    expect(git(res.cwd, 'rev-parse', 'HEAD')).toBe(originSha); // forked from origin/main
    expect(existsSync(path.join(res.cwd, 'NEW.md'))).toBe(true);
    // The session branch must NOT track origin/main (git would default-push there).
    expect(() => git(res.cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
    // And the clone's local main is untouched (still backdated).
    expect(git(co, 'rev-parse', 'main')).toBe(staleLocalSha);
  });

  test('falls back to the local base when no origin/<base> ref exists', () => {
    const repoDir = repo(); const worktreeRoot = tmp(); // makeTempRepo has NO remote
    const localSha = git(repoDir, 'rev-parse', 'main');
    const res = ensureSessionWorktree({ repoDir, worktreeRoot, projectId: 'p1', sessionId: 's10', branch: 'mochi/local-ff00', base: 'main' });
    expect(res.ok).toBe(true);
    expect(git(res.cwd, 'rev-parse', 'HEAD')).toBe(localSha);
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
