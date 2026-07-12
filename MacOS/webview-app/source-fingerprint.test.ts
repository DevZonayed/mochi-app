// Regression tests for source-fingerprint.sh — deterministic build provenance.
//
// It emits SOURCE_REV (HEAD), SOURCE_FINGERPRINT (a hash that flips on ANY
// tracked diff or untracked-file content change and is stable otherwise), and
// SOURCE_STATUS (clean|dirty). It must NEVER print source lines or secret bytes —
// diffs / file contents are folded into the hash input only. Exercised against a
// throwaway git repo so it's isolated from this worktree.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./source-fingerprint.sh', import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(dir: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
function fp(dir: string): { code: number; fields: Record<string, string>; raw: string } {
  const r = spawnSync(SCRIPT, [dir], { encoding: 'utf8' });
  const fields: Record<string, string> = {};
  for (const line of (r.stdout || '').split('\n')) { const i = line.indexOf('='); if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1); }
  return { code: r.status ?? -1, fields, raw: r.stdout || '' };
}

describe('source-fingerprint.sh', () => {
  let repo = '';
  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'mochi-fp-'));
    git(repo, 'init', '-q');
    writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); repo = ''; });

  it('reports HEAD and is stable across runs with no change', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const a = fp(repo), b = fp(repo);
    expect(a.code).toBe(0);
    expect(a.fields.SOURCE_REV).toBe(head);
    expect(a.fields.SOURCE_STATUS).toBe('clean');
    expect(a.fields.SOURCE_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fields.SOURCE_FINGERPRINT).toBe(a.fields.SOURCE_FINGERPRINT); // stable
  });

  it('changes the fingerprint for a TRACKED diff and flips status to dirty', () => {
    const before = fp(repo).fields.SOURCE_FINGERPRINT;
    writeFileSync(path.join(repo, 'a.txt'), 'hello world\n'); // modify tracked file
    const after = fp(repo);
    expect(after.fields.SOURCE_STATUS).toBe('dirty');
    expect(after.fields.SOURCE_FINGERPRINT).not.toBe(before);
  });

  it('changes the fingerprint for UNTRACKED file content (and again when it changes)', () => {
    const base = fp(repo).fields.SOURCE_FINGERPRINT;
    writeFileSync(path.join(repo, 'new.txt'), 'v1\n');
    const withUntracked = fp(repo).fields.SOURCE_FINGERPRINT;
    expect(withUntracked).not.toBe(base);
    writeFileSync(path.join(repo, 'new.txt'), 'v2\n'); // same path, new content
    const changed = fp(repo).fields.SOURCE_FINGERPRINT;
    expect(changed).not.toBe(withUntracked);
  });

  it('never prints source lines or secret bytes (only sha/rev/status)', () => {
    writeFileSync(path.join(repo, 'secret.txt'), 'TOP_SECRET_VALUE_12345\n');
    const { raw } = fp(repo);
    expect(raw).not.toContain('TOP_SECRET_VALUE_12345');
    expect(raw).not.toContain('hello');
  });

  // Regression: the macOS system shell is GNU Bash 3.2.57, whose parser treats a
  // bare apostrophe inside a comment within $(...) as an unterminated string and
  // dies with "unexpected EOF looking for matching '". CI (macos-15) and the
  // operator's Mac both reach scripts via /bin/bash, so guard the whole command
  // substitution from ever reintroducing an apostrophe/quote in a comment. The
  // other tests spawn via the shebang (a newer PATH bash) and would NOT catch it.
  it.skipIf(!existsSync('/bin/bash'))('parses and runs under macOS system bash 3.2 (/bin/bash)', () => {
    const parse = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(parse.status, `bash -n stderr: ${parse.stderr}`).toBe(0);
    const run = spawnSync('/bin/bash', [SCRIPT, repo], { encoding: 'utf8' });
    expect(run.status, `run stderr: ${run.stderr}`).toBe(0);
    expect(run.stdout).toMatch(/^SOURCE_FINGERPRINT=[0-9a-f]{64}$/m);
  });

  // ── deterministic content-manifest properties ───────────────────────────────
  it('is byte-identical across repeated calls on an unchanged tree', () => {
    const a = fp(repo).fields.SOURCE_FINGERPRINT;
    const b = fp(repo).fields.SOURCE_FINGERPRINT;
    const c = fp(repo).fields.SOURCE_FINGERPRINT;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('a DELETED tracked file changes the fingerprint and flips status to dirty', () => {
    const before = fp(repo).fields.SOURCE_FINGERPRINT;
    unlinkSync(path.join(repo, 'a.txt')); // tracked file gone from the working tree
    const after = fp(repo);
    expect(after.fields.SOURCE_STATUS).toBe('dirty');
    expect(after.fields.SOURCE_FINGERPRINT).not.toBe(before);
  });

  it('an EXECUTABLE-BIT change flips the fingerprint — tracked AND untracked', () => {
    // tracked
    const t0 = fp(repo).fields.SOURCE_FINGERPRINT;
    chmodSync(path.join(repo, 'a.txt'), 0o755);
    const t1 = fp(repo).fields.SOURCE_FINGERPRINT;
    expect(t1).not.toBe(t0);
    // untracked — the OLD `git hash-object` loop captured content only, so a chmod
    // on an untracked file did NOT change the hash. The manifest must catch it.
    const u = path.join(repo, 'tool.sh');
    writeFileSync(u, '#!/bin/sh\necho hi\n');
    chmodSync(u, 0o644);
    const u0 = fp(repo).fields.SOURCE_FINGERPRINT;
    chmodSync(u, 0o755);
    const u1 = fp(repo).fields.SOURCE_FINGERPRINT;
    expect(u1).not.toBe(u0);
  });

  it.skipIf(process.platform === 'win32')('a SYMLINK target change flips the fingerprint', () => {
    const link = path.join(repo, 'link');
    symlinkSync('target-one', link);
    const s0 = fp(repo).fields.SOURCE_FINGERPRINT;
    unlinkSync(link);
    symlinkSync('target-two', link); // same path, different target, same "content" if followed
    const s1 = fp(repo).fields.SOURCE_FINGERPRINT;
    expect(s1).not.toBe(s0);
  });

  it('a gitignored / generated file does NOT change the fingerprint', () => {
    writeFileSync(path.join(repo, '.gitignore'), 'build/\n*.log\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore');
    const base = fp(repo).fields.SOURCE_FINGERPRINT;
    mkdirSync(path.join(repo, 'build'), { recursive: true });
    writeFileSync(path.join(repo, 'build', 'artifact.bin'), 'GENERATED');
    writeFileSync(path.join(repo, 'debug.log'), 'noise');
    const after = fp(repo).fields.SOURCE_FINGERPRINT;
    expect(after).toBe(base);
  });

  it('is identical whether the repo root is passed from a nested cwd or as an absolute path', () => {
    mkdirSync(path.join(repo, 'nested', 'deep'), { recursive: true });
    const fromRoot = spawnSync(SCRIPT, [repo], { encoding: 'utf8', cwd: os.tmpdir() });
    const fromNested = spawnSync(SCRIPT, [repo], { encoding: 'utf8', cwd: path.join(repo, 'nested', 'deep') });
    const grab = (o: string) => (o.match(/^SOURCE_FINGERPRINT=([0-9a-f]{64})$/m) || [])[1];
    expect(grab(fromRoot.stdout)).toBe(grab(fromNested.stdout));
  });

  it('handles paths with spaces (and a newline if practical) — content change flips the hash, no crash', () => {
    const spaced = path.join(repo, 'a file with spaces.txt');
    writeFileSync(spaced, 'one');
    const s0 = fp(repo);
    expect(s0.code).toBe(0);
    expect(s0.fields.SOURCE_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(spaced, 'two');
    expect(fp(repo).fields.SOURCE_FINGERPRINT).not.toBe(s0.fields.SOURCE_FINGERPRINT);
    // newline in a filename (POSIX-legal) — must not crash and must stay a valid hash
    try {
      const nl = path.join(repo, 'weird\nname.txt');
      writeFileSync(nl, 'x');
      const r = fp(repo);
      expect(r.code).toBe(0);
      expect(r.fields.SOURCE_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    } catch { /* filesystem rejected the newline name — acceptable, skip */ }
  });
});
