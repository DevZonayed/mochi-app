import { describe, test, expect } from 'vitest';
import { deriveState, type LocalState, type PrStatus } from './pr-state.js';

const base: LocalState = { isRepo: true, ahead: 0, behind: 0, dirty: false, pushed: false };
function pr(over: Partial<PrStatus>): PrStatus {
  return { number: 1, url: 'u', title: 't', state: 'open', mergeable: true, mergeableState: 'clean', checks: [], ...over };
}

describe('deriveState', () => {
  test('no-repo', () => { expect(deriveState({ ...base, isRepo: false }, null)).toBe('no-repo'); });
  test('clean when no commits beyond base', () => { expect(deriveState(base, null)).toBe('clean'); });
  test('uncommitted when dirty (even with commits)', () => { expect(deriveState({ ...base, dirty: true, ahead: 2 }, null)).toBe('uncommitted'); });
  test('ready-to-push when ahead and not pushed', () => { expect(deriveState({ ...base, ahead: 2 }, null)).toBe('ready-to-push'); });
  test('ready-for-pr when pushed with commits and no PR', () => { expect(deriveState({ ...base, ahead: 2, pushed: true }, null)).toBe('ready-for-pr'); });
  test('pr-mergeable (clean → Merge)', () => { expect(deriveState({ ...base, ahead: 2, pushed: true }, pr({ mergeableState: 'clean' }))).toBe('pr-mergeable'); });
  test('pr-conflicts (dirty → Resolve)', () => { expect(deriveState({ ...base, ahead: 2, pushed: true }, pr({ mergeableState: 'dirty' }))).toBe('pr-conflicts'); });
  test('pr-blocked on blocked/behind/unstable', () => {
    for (const ms of ['blocked', 'behind', 'unstable', 'unknown'] as const) {
      expect(deriveState({ ...base, pushed: true }, pr({ mergeableState: ms }))).toBe('pr-blocked');
    }
  });
  test('pr-merged regardless of local', () => { expect(deriveState(base, pr({ state: 'merged' }))).toBe('pr-merged'); });
  test('pr-closed unmerged', () => { expect(deriveState(base, pr({ state: 'closed' }))).toBe('pr-closed'); });
  // Track 7: the new optional fields baseRefName + mergedAt are inert in the
  // state machine — they're metadata the UI reads, not signal the derivation
  // uses. Make that contract explicit so a future refactor that accidentally
  // gates on them gets caught.
  test('baseRefName + mergedAt are state-machine-inert', () => {
    expect(deriveState(base, pr({ state: 'merged', baseRefName: 'main', mergedAt: 1700000000000 }))).toBe('pr-merged');
    expect(deriveState(base, pr({ state: 'merged' }))).toBe('pr-merged');
    expect(deriveState({ ...base, ahead: 2, pushed: true }, pr({ baseRefName: 'main' }))).toBe('pr-mergeable');
  });
});
