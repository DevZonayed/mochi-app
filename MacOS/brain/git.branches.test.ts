import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTempRepo } from './test-helpers.js';
import { listBranches } from './git.js';

/* The unit boundary is `listBranches(repoDir)`. Per the project's test style
   (see git.worktree.test.ts), we drive it via real temp repos rather than
   mocking the private `execGit` helper — that keeps the test honest about
   git's actual output format (the bug surface this code is meant to absorb). */

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function git(cwd: string, ...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }

/** Build a tiny bare repo to serve as `origin` for a clone, so we can exercise
    the remote-only + origin/HEAD branches without hitting the network. */
function bareOriginWithBranches(branches: string[], headBranch: string): string {
  const bare = mkdtempSync(path.join(tmpdir(), 'mst-bare-')) + '.git';
  cleanup.push(bare);
  // Seed a normal repo, then push every branch into a bare clone.
  const seed = makeTempRepo();
  cleanup.push(seed);
  for (const b of branches) {
    if (b !== 'main') git(seed, 'checkout', '-b', b);
    writeFileSync(path.join(seed, `${b}.txt`), `hello from ${b}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', `seed ${b}`);
  }
  git(seed, 'checkout', headBranch);
  execFileSync('git', ['init', '--bare', '-q', '-b', headBranch, bare], { encoding: 'utf8' });
  execFileSync('git', ['-C', seed, 'remote', 'add', 'origin', bare]);
  for (const b of branches) execFileSync('git', ['-C', seed, 'push', '-q', 'origin', b]);
  return bare;
}

describe('listBranches', () => {
  test('returns [] for a non-repo path', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'mst-nope-'));
    cleanup.push(d);
    expect(listBranches(d)).toEqual([]);
  });

  test('returns [] for an empty/missing path', () => {
    expect(listBranches('')).toEqual([]);
    expect(listBranches('/this/path/should/not/exist/maestro/x')).toEqual([]);
  });

  test('all-local: lists every local branch, flags current, no remotes', () => {
    const r = repo();
    git(r, 'branch', 'feat/login');
    git(r, 'branch', 'feat/signup');
    const out = listBranches(r);
    const names = out.map(b => b.name).sort();
    expect(names).toEqual(['feat/login', 'feat/signup', 'main']);
    const main = out.find(b => b.name === 'main');
    expect(main?.isCurrent).toBe(true);
    expect(out.every(b => b.hasRemote === false)).toBe(true);
    // Every entry should report a lastCommit (the seed commit).
    expect(out.every(b => b.lastCommit && b.lastCommit.sha.length > 0)).toBe(true);
  });

  test('no origin/HEAD → no branch is flagged default', () => {
    const r = repo();
    const out = listBranches(r);
    expect(out.every(b => b.isDefault === false)).toBe(true);
  });

  test('with origin: detects default via origin/HEAD, marks hasRemote', () => {
    const bare = bareOriginWithBranches(['main', 'develop'], 'main');
    const clone = mkdtempSync(path.join(tmpdir(), 'mst-clone-'));
    cleanup.push(clone);
    execFileSync('git', ['clone', '-q', bare, clone]);
    execFileSync('git', ['-C', clone, 'config', 'user.email', 'test@local']);
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'Test']);

    const out = listBranches(clone);
    const main = out.find(b => b.name === 'main');
    const develop = out.find(b => b.name === 'develop');
    expect(main).toBeDefined();
    expect(develop).toBeDefined();
    expect(main!.isDefault).toBe(true);
    expect(main!.isCurrent).toBe(true);
    expect(main!.hasRemote).toBe(true);
    expect(develop!.isDefault).toBe(false);
    // develop is remote-only at this point — no local checkout — so it's
    // hasRemote:true, isCurrent:false.
    expect(develop!.hasRemote).toBe(true);
    expect(develop!.isCurrent).toBe(false);
    // Sort: default first.
    expect(out[0].name).toBe('main');
  });

  test('mixed: a branch present locally + on origin is deduped (local wins, hasRemote:true)', () => {
    const bare = bareOriginWithBranches(['main', 'shared'], 'main');
    const clone = mkdtempSync(path.join(tmpdir(), 'mst-clone-'));
    cleanup.push(clone);
    execFileSync('git', ['clone', '-q', bare, clone]);
    execFileSync('git', ['-C', clone, 'config', 'user.email', 'test@local']);
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'Test']);
    // Materialize `shared` locally so both local AND origin/shared exist.
    execFileSync('git', ['-C', clone, 'checkout', '-q', '-b', 'shared', 'origin/shared']);
    execFileSync('git', ['-C', clone, 'checkout', '-q', 'main']);

    const out = listBranches(clone);
    const shared = out.filter(b => b.name === 'shared');
    expect(shared).toHaveLength(1);                // not duplicated
    expect(shared[0].hasRemote).toBe(true);        // remote pass patched the flag
    expect(shared[0].isCurrent).toBe(false);       // not the checked-out branch
  });

  test('sort order: default, then current, then alpha', () => {
    const bare = bareOriginWithBranches(['main', 'aaa', 'zzz'], 'main');
    const clone = mkdtempSync(path.join(tmpdir(), 'mst-clone-'));
    cleanup.push(clone);
    execFileSync('git', ['clone', '-q', bare, clone]);
    execFileSync('git', ['-C', clone, 'config', 'user.email', 'test@local']);
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'Test']);
    // Make current = `aaa` (not the default `main`) to test the current-second rule.
    execFileSync('git', ['-C', clone, 'checkout', '-q', '-b', 'aaa', 'origin/aaa']);

    const out = listBranches(clone);
    expect(out[0].name).toBe('main');  // default first
    expect(out[1].name).toBe('aaa');   // current second
    expect(out[2].name).toBe('zzz');   // remote-only, alpha after current
  });
});
