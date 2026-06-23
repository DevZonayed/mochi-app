/* useSessionLocked is one line, but the contract has bite: it MUST return
   true ONLY for 'pr-merged' and false for every other state, including the
   pre-merge 'pr-mergeable' (operators almost always type that one in the
   middle of the merge flow — locking it would be a usability disaster).

   We mock useSessionStateOnly so the hook stays pure (no api / IPC plumbing
   in unit tests). */
import { describe, test, expect, vi } from 'vitest';
import type { SessionGitState } from '../lib/git-types';

const stateMock = vi.fn<(id: string | null | undefined) => SessionGitState | null>();
vi.mock('../lib/useSessionGitState', () => ({ useSessionStateOnly: (id: string | null | undefined) => stateMock(id) }));

// Imported AFTER the mock — useSessionLocked is a thin wrapper, so a simple
// fn() call inside the test is enough; we don't need React's renderHook here.
import { useSessionLocked } from './useSessionLocked.js';

describe('useSessionLocked', () => {
  test('returns true ONLY for pr-merged', () => {
    const cases: { state: SessionGitState; locked: boolean }[] = [
      { state: 'no-repo', locked: false },
      { state: 'clean', locked: false },
      { state: 'uncommitted', locked: false },
      { state: 'ready-to-push', locked: false },
      { state: 'ready-for-pr', locked: false },
      { state: 'pr-mergeable', locked: false },
      { state: 'pr-conflicts', locked: false },
      { state: 'pr-blocked', locked: false },
      { state: 'pr-merged', locked: true },
      { state: 'pr-closed', locked: false },
    ];
    for (const c of cases) {
      stateMock.mockReturnValueOnce(c.state);
      expect(useSessionLocked('s1')).toBe(c.locked);
    }
  });

  test('returns false when the cache has no entry yet (state === null)', () => {
    stateMock.mockReturnValueOnce(null);
    expect(useSessionLocked('s1')).toBe(false);
  });

  test('returns false for null/empty sessionId', () => {
    stateMock.mockReturnValueOnce(null);
    expect(useSessionLocked(null)).toBe(false);
    stateMock.mockReturnValueOnce(null);
    expect(useSessionLocked(undefined)).toBe(false);
  });
});
