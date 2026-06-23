/* Tests for the repo-open lifecycle helpers: `ensureGitHooks` and
 * `ensureCommitIdentity`. Uses real temp git repos (cheap, ~10 ms each) +
 * an injected `gh api user` fake so we never shell out to the real `gh`. */

import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo, makeTempDir } from './test-helpers.js';
import { ensureGitHooks, ensureCommitIdentity, isHarnessDefault, type GhUser } from './git-identity.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function tmp(): string { const d = makeTempDir(); cleanup.push(d); return d; }

function gitConfigGet(repoDir: string, key: string): string | null {
  try { return execFileSync('git', ['-C', repoDir, 'config', '--local', '--get', key], { encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

function gitConfigSet(repoDir: string, key: string, value: string): void {
  execFileSync('git', ['-C', repoDir, 'config', '--local', key, value]);
}

function gitConfigUnset(repoDir: string, key: string): void {
  try { execFileSync('git', ['-C', repoDir, 'config', '--local', '--unset', key]); } catch { /* not set */ }
}

const FAKE_USER: GhUser = { login: 'octocat', name: 'Octo Cat', email: 'octo@example.com' };
const PRIVATE_USER: GhUser = { login: 'octocat', name: 'Octo Cat', email: null };

describe('isHarnessDefault', () => {
  test('treats null + known harness values as overwritable', () => {
    expect(isHarnessDefault(null)).toBe(true);
    expect(isHarnessDefault('')).toBe(true);
    expect(isHarnessDefault('Maestro')).toBe(true);
    expect(isHarnessDefault('maestro@local')).toBe(true);
    expect(isHarnessDefault('root')).toBe(true);
  });
  test('leaves real operator identities untouched', () => {
    expect(isHarnessDefault('Octo Cat')).toBe(false);
    expect(isHarnessDefault('jane@example.com')).toBe(false);
  });
});

describe('ensureGitHooks', () => {
  test('sets core.hooksPath to .githooks exactly when the dir is committed', async () => {
    const r = repo();
    expect(gitConfigGet(r, 'core.hooksPath')).toBeNull();

    // No .githooks/ → no-op (we don't want to point git at a non-existent path).
    await ensureGitHooks(r);
    expect(gitConfigGet(r, 'core.hooksPath')).toBeNull();

    // Commit the dir → next call wires it up.
    mkdirSync(path.join(r, '.githooks'));
    writeFileSync(path.join(r, '.githooks', 'prepare-commit-msg'), '#!/bin/sh\nexit 0\n');
    await ensureGitHooks(r);
    expect(gitConfigGet(r, 'core.hooksPath')).toBe('.githooks');
  });

  test('is idempotent — a second call leaves the config unchanged', async () => {
    const r = repo();
    mkdirSync(path.join(r, '.githooks'));
    await ensureGitHooks(r);
    await ensureGitHooks(r);
    expect(gitConfigGet(r, 'core.hooksPath')).toBe('.githooks');
  });

  test('no-ops on a non-repo path without throwing', async () => {
    const d = tmp(); // empty dir, not a git repo
    await expect(ensureGitHooks(d)).resolves.toBeUndefined();
  });

  test('no-ops when path does not exist', async () => {
    await expect(ensureGitHooks('/nonexistent/path/here')).resolves.toBeUndefined();
  });
});

describe('ensureCommitIdentity', () => {
  test('writes gh-derived identity into a repo whose config is missing', async () => {
    const r = repo();
    // makeTempRepo pre-sets test@local / Test — our default-set treats those as
    // operator-set, so for this case we unset them to simulate a fresh clone.
    gitConfigUnset(r, 'user.name');
    gitConfigUnset(r, 'user.email');

    const res = await ensureCommitIdentity(r, { fetchGhUser: async () => FAKE_USER });
    expect(res.changed).toBe(true);
    expect(res.reason).toBe('updated to gh identity');
    expect(gitConfigGet(r, 'user.name')).toBe('Octo Cat');
    expect(gitConfigGet(r, 'user.email')).toBe('octo@example.com');
  });

  test('falls back to <login>@users.noreply.github.com when email is private', async () => {
    const r = repo();
    gitConfigUnset(r, 'user.name');
    gitConfigUnset(r, 'user.email');

    await ensureCommitIdentity(r, { fetchGhUser: async () => PRIVATE_USER });
    expect(gitConfigGet(r, 'user.email')).toBe('octocat@users.noreply.github.com');
  });

  test('overwrites harness defaults (Maestro / maestro@local)', async () => {
    const r = repo();
    gitConfigSet(r, 'user.name', 'Maestro');
    gitConfigSet(r, 'user.email', 'maestro@local');

    const res = await ensureCommitIdentity(r, { fetchGhUser: async () => FAKE_USER });
    expect(res.changed).toBe(true);
    expect(gitConfigGet(r, 'user.name')).toBe('Octo Cat');
    expect(gitConfigGet(r, 'user.email')).toBe('octo@example.com');
  });

  test('leaves a real operator identity alone (no force)', async () => {
    const r = repo(); // makeTempRepo sets Test / test@local — both real-looking
    const res = await ensureCommitIdentity(r, { fetchGhUser: async () => FAKE_USER });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('operator identity already set');
    expect(gitConfigGet(r, 'user.name')).toBe('Test');
    expect(gitConfigGet(r, 'user.email')).toBe('test@local');
  });

  test('force=true overwrites even a real operator identity', async () => {
    const r = repo();
    const res = await ensureCommitIdentity(r, { fetchGhUser: async () => FAKE_USER, force: true });
    expect(res.changed).toBe(true);
    expect(gitConfigGet(r, 'user.name')).toBe('Octo Cat');
  });

  test('no-ops when gh is not signed in (fetcher returns null)', async () => {
    const r = repo();
    gitConfigUnset(r, 'user.name');
    gitConfigUnset(r, 'user.email');
    const res = await ensureCommitIdentity(r, { fetchGhUser: async () => null });
    expect(res.changed).toBe(false);
    expect(res.reason).toContain('gh user not available');
    // Should not have written anything bogus.
    expect(gitConfigGet(r, 'user.name')).toBeNull();
  });

  test('no-ops on a non-repo path', async () => {
    const d = tmp();
    const res = await ensureCommitIdentity(d, { fetchGhUser: async () => FAKE_USER });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('not a git repo');
  });

  test('rewrites a gh-derived noreply email when gh later exposes a public one', async () => {
    const r = repo();
    gitConfigSet(r, 'user.name', 'Maestro');
    gitConfigSet(r, 'user.email', 'maestro@local');

    // First pass: private email.
    await ensureCommitIdentity(r, { fetchGhUser: async () => PRIVATE_USER });
    expect(gitConfigGet(r, 'user.email')).toBe('octocat@users.noreply.github.com');

    // A noreply email is NOT a harness default, so the second call should
    // leave it alone without force. That's the conservative behavior we want.
    const second = await ensureCommitIdentity(r, { fetchGhUser: async () => FAKE_USER });
    expect(second.changed).toBe(false);
    expect(gitConfigGet(r, 'user.email')).toBe('octocat@users.noreply.github.com');
  });
});

describe('the trailer-stripping hook itself', () => {
  test('strips Claude attribution but keeps human co-authors and is idempotent', () => {
    // Locate the committed hook by walking up from this test file's dir.
    const here = path.dirname(new URL(import.meta.url).pathname);
    // electron/ → apps/desktop/ → apps/ → repo root
    const repoRoot = path.resolve(here, '..', '..', '..');
    const hook = path.join(repoRoot, '.githooks', 'prepare-commit-msg');
    expect(existsSync(hook)).toBe(true);

    const msgPath = path.join(tmp(), 'COMMIT_EDITMSG');
    const dirty = [
      'feat(desktop): inline attachment chips',
      '',
      'Pasted images render as composer chips.',
      '',
      'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>',
      'Co-Authored-By: Jane Doe <jane@example.com>',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'Generated by Claude Code',
      '',
    ].join('\n');
    writeFileSync(msgPath, dirty);

    execFileSync(hook, [msgPath, 'message']);
    const cleaned1 = execFileSync('cat', [msgPath], { encoding: 'utf8' });
    expect(cleaned1).not.toMatch(/Claude Opus/);
    expect(cleaned1).not.toMatch(/noreply@anthropic\.com/);
    expect(cleaned1).not.toMatch(/🤖 Generated with/);
    expect(cleaned1).not.toMatch(/^Generated by Claude Code$/m);
    expect(cleaned1).toMatch(/Co-Authored-By: Jane Doe <jane@example\.com>/);
    expect(cleaned1).toMatch(/^feat\(desktop\):/);

    // Idempotent: a second pass must produce identical output.
    execFileSync(hook, [msgPath, 'message']);
    const cleaned2 = execFileSync('cat', [msgPath], { encoding: 'utf8' });
    expect(cleaned2).toBe(cleaned1);
  });

  test('leaves a clean message completely untouched', () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const repoRoot = path.resolve(here, '..', '..', '..');
    const hook = path.join(repoRoot, '.githooks', 'prepare-commit-msg');

    const msgPath = path.join(tmp(), 'COMMIT_EDITMSG');
    const clean = 'fix(server): handle empty SSE frames\n\nBody.\n';
    writeFileSync(msgPath, clean);

    execFileSync(hook, [msgPath, 'message']);
    const after = execFileSync('cat', [msgPath], { encoding: 'utf8' });
    expect(after).toBe(clean);
  });
});
