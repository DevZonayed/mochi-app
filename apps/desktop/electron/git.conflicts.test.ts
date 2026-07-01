/* listConflictedFiles — small helper used by GitService.previewResolveSession
   to render the conflict-confirmation dialog without touching the worktree.
   Works against a real git repo (forces a conflict by merging two divergent
   branches), so it exercises the actual `git status --porcelain` parsing. */

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listConflictedFiles, mergeBaseIntoBranch } from './git.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });

function makeRepoWithConflict(): string {
  const dir = path.join(tmpdir(), `mochi-conflict-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  cleanup.push(dir);
  const sh = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', dir, '-b', 'main'], { encoding: 'utf8' });
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  sh('add', '.'); sh('commit', '-q', '-m', 'init');
  // branch off, diverge on a.txt
  sh('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'a.txt'), 'feature\n');
  sh('add', '.'); sh('commit', '-q', '-m', 'feature side');
  sh('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  sh('add', '.'); sh('commit', '-q', '-m', 'main side');
  sh('checkout', '-q', 'feature');
  // Merging main → feature will conflict on a.txt and leave the merge mid-flight.
  mergeBaseIntoBranch(dir, 'main');
  return dir;
}

describe('listConflictedFiles', () => {
  it('returns [] on a clean repo', () => {
    const dir = path.join(tmpdir(), `mochi-clean-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    cleanup.push(dir);
    execFileSync('git', ['init', '-q', dir, '-b', 'main'], { encoding: 'utf8' });
    expect(listConflictedFiles(dir)).toEqual([]);
  });

  it('returns [] on a non-repo path', () => {
    expect(listConflictedFiles('/tmp/definitely-not-a-repo-' + Date.now())).toEqual([]);
  });

  it('lists each unmerged path after a conflicting merge', () => {
    const dir = makeRepoWithConflict();
    const files = listConflictedFiles(dir);
    expect(files).toContain('a.txt');
  });
});
