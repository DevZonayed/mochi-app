/* parseConflictHunks / getConflictHunks / getActiveConflictHunks — the parser
   the T8 AI-resolve dialog feeds onto its read-only HUNK preview. Two layers:

     1. Pure-string parsing (parseConflictHunks): covers the marker shapes git
        actually emits — standard 3-way (`<<<<<<<` / `=======` / `>>>>>>>`),
        diff3-style (with `||||||| base`), trailing newlines, and corrupted /
        unterminated blocks that must be DROPPED, not crash.
     2. Disk + real `git merge` (getConflictHunks/getActiveConflictHunks): make
        a tempdir, branch + diverge + merge, then assert the parser reads the
        real on-disk file. This is the same shape the AI-resolve dialog sees
        at runtime — no mocks, no doubles. */

import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempRepo } from './test-helpers.js';
import { parseConflictHunks, getConflictHunks, getActiveConflictHunks } from './git.js';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });
function repo(): string { const d = makeTempRepo(); cleanup.push(d); return d; }
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

describe('parseConflictHunks — pure parser', () => {
  test('parses a single standard 3-way marker block', () => {
    const text = [
      'line one',
      '<<<<<<< HEAD',
      'ours line A',
      'ours line B',
      '=======',
      'theirs line A',
      '>>>>>>> feature',
      'tail',
    ].join('\n');
    const hunks = parseConflictHunks(text);
    expect(hunks).toHaveLength(1);
    const h = hunks[0];
    expect(h.startLine).toBe(2);
    expect(h.endLine).toBe(7);
    expect(h.oursLabel).toBe('HEAD');
    expect(h.theirsLabel).toBe('feature');
    expect(h.ours).toEqual(['ours line A', 'ours line B']);
    expect(h.theirs).toEqual(['theirs line A']);
    expect(h.base).toBeUndefined();
  });

  test('parses diff3-style markers (base section captured)', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours',
      '||||||| merged common ancestors',
      'base',
      '=======',
      'theirs',
      '>>>>>>> branch',
    ].join('\n');
    const hunks = parseConflictHunks(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].base).toEqual(['base']);
    expect(hunks[0].ours).toEqual(['ours']);
    expect(hunks[0].theirs).toEqual(['theirs']);
  });

  test('parses MULTIPLE conflict blocks in one file', () => {
    const text = [
      '<<<<<<< HEAD',
      'A1',
      '=======',
      'B1',
      '>>>>>>> feat',
      'between',
      '<<<<<<< HEAD',
      'A2',
      '=======',
      'B2',
      '>>>>>>> feat',
    ].join('\n');
    const hunks = parseConflictHunks(text);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].ours).toEqual(['A1']);
    expect(hunks[1].ours).toEqual(['A2']);
  });

  test('returns [] when the file has no markers', () => {
    expect(parseConflictHunks('hello\nworld\n')).toEqual([]);
  });

  test('DROPS a hunk whose `>>>>>>>` close is missing (unterminated)', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      // no >>>>>>> at all
    ].join('\n');
    expect(parseConflictHunks(text)).toEqual([]);
  });

  test('DROPS a hunk that never crossed `=======` separator', () => {
    const text = [
      '<<<<<<< HEAD',
      'ours',
      '>>>>>>> feat',
    ].join('\n');
    expect(parseConflictHunks(text)).toEqual([]);
  });

  test('handles CRLF line endings without offsetting line ranges', () => {
    const text = '<<<<<<< HEAD\r\nA\r\n=======\r\nB\r\n>>>>>>> feat\r\n';
    const hunks = parseConflictHunks(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].startLine).toBe(1);
    expect(hunks[0].endLine).toBe(5);
    expect(hunks[0].ours).toEqual(['A']);
    expect(hunks[0].theirs).toEqual(['B']);
  });
});

describe('getConflictHunks — reads from disk', () => {
  test('returns one entry per input file, even when the file is missing', () => {
    const r = repo();
    writeFileSync(path.join(r, 'a.txt'),
      '<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> feat\n');
    const out = getConflictHunks(r, ['a.txt', 'does-not-exist.txt']);
    expect(out).toHaveLength(2);
    expect(out[0].path).toBe('a.txt');
    expect(out[0].hunks).toHaveLength(1);
    expect(out[1].path).toBe('does-not-exist.txt');
    expect(out[1].unreadable).toBe(true);
  });
});

describe('getActiveConflictHunks — end-to-end with real git merge', () => {
  test('detects + parses conflicts produced by an actual merge', () => {
    const r = repo();
    // diverge on `feat` and on `main` so the merge cannot fast-forward.
    writeFileSync(path.join(r, 'note.txt'), 'shared header\nORIGINAL LINE\nshared footer\n');
    git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'seed');

    git(r, 'checkout', '-q', '-b', 'feat');
    writeFileSync(path.join(r, 'note.txt'), 'shared header\nFEATURE LINE\nshared footer\n');
    git(r, 'commit', '-q', '-am', 'on feat');

    git(r, 'checkout', '-q', 'main');
    writeFileSync(path.join(r, 'note.txt'), 'shared header\nMAIN LINE\nshared footer\n');
    git(r, 'commit', '-q', '-am', 'on main');

    // Merge `feat` INTO main — guaranteed to conflict on note.txt.
    try { git(r, 'merge', '--no-edit', 'feat'); } catch { /* expected to fail */ }

    const conflicted = readFileSync(path.join(r, 'note.txt'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('=======');
    expect(conflicted).toContain('>>>>>>>');

    const { files } = getActiveConflictHunks(r);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('note.txt');
    expect(files[0].hunks.length).toBeGreaterThan(0);

    const h = files[0].hunks[0];
    // The hunk's `ours` payload is whatever was on HEAD at merge time (= main).
    expect(h.ours.join('\n')).toContain('MAIN LINE');
    expect(h.theirs.join('\n')).toContain('FEATURE LINE');
  });

  test('returns an empty file list when there is no merge in progress', () => {
    const r = repo();
    const { files } = getActiveConflictHunks(r);
    expect(files).toEqual([]);
  });
});
