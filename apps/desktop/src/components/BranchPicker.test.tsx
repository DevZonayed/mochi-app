/* Pure helpers behind <BranchPicker /> — filtering and default-row selection.
   Per project memory (desktop-renderer-tests-not-wired): src/** tests aren't
   in `pnpm test`. Run via a throwaway vitest config, e.g.:
     pnpm exec vitest run --config <(echo "import {defineConfig} from 'vitest/config';
     export default defineConfig({test:{include:['src/**\/*.test.tsx']}});")
   The component itself is JSX-only glue around these helpers + the api IPC. */
import { describe, test, expect } from 'vitest';
import { filterBranches, defaultIndex } from './BranchPicker';
import type { BranchInfo } from '../lib/api';

const mk = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  isDefault: false,
  isCurrent: false,
  hasRemote: true,
  lastCommit: { sha: 'abc1234', subject: `commit on ${name}`, date: 1718000000 },
  ...extra,
});

describe('filterBranches', () => {
  test('empty query returns the full list (same reference is fine — caller treats as readonly)', () => {
    const all = [mk('main'), mk('develop'), mk('feat/login')];
    expect(filterBranches(all, '')).toEqual(all);
    expect(filterBranches(all, '   ')).toEqual(all);
  });

  test('matches on the branch name, case-insensitive', () => {
    const all = [mk('main'), mk('feat/Login'), mk('feat/signup')];
    expect(filterBranches(all, 'login').map(b => b.name)).toEqual(['feat/Login']);
    expect(filterBranches(all, 'FEAT').map(b => b.name)).toEqual(['feat/Login', 'feat/signup']);
  });

  test('also matches against the last-commit subject', () => {
    const all = [
      mk('a', { lastCommit: { sha: '1', subject: 'rewrite the auth flow', date: 0 } }),
      mk('b', { lastCommit: { sha: '2', subject: 'fix the off-by-one', date: 0 } }),
    ];
    expect(filterBranches(all, 'auth').map(b => b.name)).toEqual(['a']);
    expect(filterBranches(all, 'off-by-one').map(b => b.name)).toEqual(['b']);
  });

  test('returns [] when nothing matches', () => {
    const all = [mk('main'), mk('feat/login')];
    expect(filterBranches(all, 'zzz-not-here')).toEqual([]);
  });

  test('handles branches with no lastCommit (recent unborn branch case)', () => {
    // `m` has no lastCommit; `feat/x`'s default subject is `commit on feat/x`.
    // A query that ONLY matches the missing-lastCommit branch's name proves
    // the null-guard works (no TypeError on b.lastCommit.subject).
    const all = [mk('m', { lastCommit: null }), mk('feat/x')];
    // "feat" matches feat/x by name (and its subject); "xyz-no-match" matches nothing.
    expect(filterBranches(all, 'feat').map(b => b.name)).toEqual(['feat/x']);
    expect(filterBranches(all, 'xyz-no-match')).toEqual([]);
    // A query that matches the no-commit branch's name still finds it (no crash).
    expect(filterBranches(all.slice(0, 1), 'm').map(b => b.name)).toEqual(['m']);
  });
});

describe('defaultIndex', () => {
  test('returns the index of the flagged default', () => {
    const all = [mk('main', { isDefault: true }), mk('develop'), mk('feat/x')];
    expect(defaultIndex(all)).toBe(0);
  });

  test('returns 0 when no branch is flagged default (e.g. no origin/HEAD)', () => {
    const all = [mk('a'), mk('b'), mk('c')];
    expect(defaultIndex(all)).toBe(0);
  });

  test('returns the right index when default is NOT first', () => {
    const all = [mk('aaa'), mk('main', { isDefault: true }), mk('zzz')];
    expect(defaultIndex(all)).toBe(1);
  });

  test('returns 0 on an empty list (no crash)', () => {
    expect(defaultIndex([])).toBe(0);
  });
});
