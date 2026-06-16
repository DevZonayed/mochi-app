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
});
