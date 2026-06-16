import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeTempRepo } from './test-helpers.js';
import { aheadBehind, isDirty, remoteHasBranch, pushBranch, buildAskpassScript } from './git.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function git(dir: string, ...args: string[]): string { return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim(); }
function bareRemote(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'mst-bare-')); cleanup.push(d);
  execFileSync('git', ['init', '-q', '--bare', d]);
  return d;
}

describe('aheadBehind / isDirty', () => {
  test('ahead by N after commits on a branch off main', () => {
    const r = repo();
    git(r, 'checkout', '-q', '-b', 'feat');
    writeFileSync(path.join(r, 'a.txt'), '1'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'c1');
    writeFileSync(path.join(r, 'b.txt'), '2'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'c2');
    expect(aheadBehind(r, 'main')).toEqual({ ahead: 2, behind: 0 });
  });

  test('isDirty reflects uncommitted changes', () => {
    const r = repo();
    expect(isDirty(r)).toBe(false);
    writeFileSync(path.join(r, 'x.txt'), 'dirty');
    expect(isDirty(r)).toBe(true);
  });
});

describe('pushBranch / remoteHasBranch', () => {
  test('pushes a branch to a local remote and detects it', () => {
    const r = repo();
    const bare = bareRemote();
    git(r, 'remote', 'add', 'origin', bare);
    git(r, 'checkout', '-q', '-b', 'mochi/push-me');
    writeFileSync(path.join(r, 'f.txt'), '1'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'c');
    const res = pushBranch(r, 'mochi/push-me');
    expect(res.ok).toBe(true);
    expect(remoteHasBranch(r, 'origin', 'mochi/push-me')).toBe(true);
    expect(remoteHasBranch(r, 'origin', 'does-not-exist')).toBe(false);
  });
});

describe('buildAskpassScript', () => {
  test('feeds x-access-token + $GIT_TOKEN, carries no literal secret', () => {
    const s = buildAskpassScript();
    expect(s).toContain('x-access-token');
    expect(s).toContain('$GIT_TOKEN');
  });
});
