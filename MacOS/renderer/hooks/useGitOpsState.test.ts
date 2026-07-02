/* Pure mapping tests for the dock's state-→-actions function. No React, no
   IPC — just the state machine driving the buttons. Locks in the contract
   so a state-rename or new state has to opt into a curated action list
   (rather than silently degrading to "no actions"). */

import { describe, test, expect } from 'vitest';
import { actionsFor, labelFor, behindBaseLabel } from './useGitOpsState';
import type { SessionGitState, SessionGitStatus } from '../lib/git-types';

function status(over: Partial<SessionGitStatus> = {}): SessionGitStatus {
  return {
    sessionId: 'sid', branch: 'mochi/lyon/lyon', base: 'master',
    local: { isRepo: true, ahead: 0, behind: 0, dirty: false, pushed: false },
    pr: null, state: 'clean', lastCheckedAt: Date.now(),
    ...over,
  } as SessionGitStatus;
}

const ALL_STATES: SessionGitState[] = [
  'no-repo', 'clean', 'uncommitted', 'ready-to-push', 'ready-for-pr',
  'pr-mergeable', 'pr-conflicts', 'pr-blocked', 'pr-merged', 'pr-closed',
];

describe('actionsFor — state → action list', () => {
  test('every state has either zero actions or a primary at index 0', () => {
    for (const s of ALL_STATES) {
      const list = actionsFor(s);
      // The dock's collapsed pill reads list[0] as the primary; the
      // expanded dock surfaces the rest. Verify the shape.
      if (list.length > 0) expect(list[0].label.length).toBeGreaterThan(0);
    }
  });

  test('no-repo / clean / pr-closed have no actions', () => {
    expect(actionsFor('no-repo')).toEqual([]);
    expect(actionsFor('clean')).toEqual([]);
    expect(actionsFor('pr-closed')).toEqual([]);
  });

  test('uncommitted → primary is Commit', () => {
    const a = actionsFor('uncommitted');
    expect(a[0].kind).toBe('commit');
    expect(a[0].tone).toBe('primary');
  });

  test('ready-to-push → primary is Push (not destructive, no GitHub needed)', () => {
    const a = actionsFor('ready-to-push')[0];
    expect(a.kind).toBe('push');
    expect(a.destructive).toBe(false);
    expect(a.needsGitHub).toBe(false);
  });

  test('ready-for-pr → primary is Open PR and needs GitHub', () => {
    const a = actionsFor('ready-for-pr')[0];
    expect(a.kind).toBe('create-pr');
    expect(a.needsGitHub).toBe(true);
  });

  test('pr-mergeable → primary is Merge, destructive + needs GitHub', () => {
    const a = actionsFor('pr-mergeable')[0];
    expect(a.kind).toBe('merge');
    expect(a.destructive).toBe(true);
    expect(a.needsGitHub).toBe(true);
  });

  test('pr-conflicts → primary is Resolve (danger tone), destructive', () => {
    const a = actionsFor('pr-conflicts')[0];
    expect(a.kind).toBe('resolve');
    expect(a.tone).toBe('danger');
    expect(a.destructive).toBe(true);
  });

  test('pr-blocked → primary is Open PR ↗ (no destructive op)', () => {
    const a = actionsFor('pr-blocked')[0];
    expect(a.kind).toBe('open-pr');
    expect(a.destructive).toBe(false);
  });

  test('pr-merged → primary is Continue — non-destructive, NOT a stub (wired in T7)', () => {
    const a = actionsFor('pr-merged');
    expect(a[0].kind).toBe('continue');
    expect(a[0].tone).toBe('primary');
    expect(a[0].destructive).toBe(false);
    // The stub flag was the placeholder during T5 — T7 wired the action via
    // the host-supplied `onContinue` callback (ChatThread.continueFromHere).
    expect(a[0].stub).toBeFalsy();
    // Archive worktree IS destructive and present in the secondary list.
    const archive = a.find(x => x.kind === 'archive');
    expect(archive?.destructive).toBe(true);
  });

  test('every destructive action carries a confirm prompt', () => {
    for (const s of ALL_STATES) {
      for (const a of actionsFor(s)) {
        if (a.destructive) expect(a.confirm, `${s}/${a.kind} missing confirm copy`).toBeTruthy();
      }
    }
  });

  test('view-diff is offered in every non-trivial dirty / PR state', () => {
    for (const s of ['uncommitted', 'ready-to-push', 'ready-for-pr', 'pr-mergeable', 'pr-conflicts', 'pr-blocked'] as SessionGitState[]) {
      expect(actionsFor(s).some(a => a.kind === 'view-diff'), `${s} missing view-diff`).toBe(true);
    }
  });

  test('every action carries a human label', () => {
    for (const s of ALL_STATES) {
      for (const a of actionsFor(s)) {
        expect(a.label.length, `${s}/${a.kind}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('labelFor — state → pill label', () => {
  test('returns a non-empty string for every state', () => {
    for (const s of ALL_STATES) expect(labelFor(s).length).toBeGreaterThan(0);
  });

  test('uses plain English (no internal state slugs)', () => {
    expect(labelFor('pr-mergeable')).not.toContain('-');
    expect(labelFor('pr-conflicts')).not.toContain('-');
    expect(labelFor('ready-to-push')).not.toContain('-');
  });
});

describe('behindBaseLabel — "↓ behind master by N"', () => {
  // Single source of truth for the copy on TWO surfaces (collapsed pill
  // mini-chip + expanded dock prominent row). Tests pin both shapes so a
  // future copy change has to be intentional.
  test('null status → null', () => {
    expect(behindBaseLabel(null)).toBeNull();
  });
  test('behind===0 → null (nothing to show)', () => {
    expect(behindBaseLabel(status({ local: { isRepo: true, ahead: 0, behind: 0, dirty: false, pushed: false } }))).toBeNull();
  });
  test('null base → null (no base to call out)', () => {
    expect(behindBaseLabel(status({ base: null, local: { isRepo: true, ahead: 0, behind: 5, dirty: false, pushed: false } }))).toBeNull();
  });
  test('singular: "1 commit"', () => {
    expect(behindBaseLabel(status({ base: 'master', local: { isRepo: true, ahead: 0, behind: 1, dirty: false, pushed: false } })))
      .toBe('Behind master by 1 commit');
  });
  test('plural: "N commits"', () => {
    expect(behindBaseLabel(status({ base: 'master', local: { isRepo: true, ahead: 0, behind: 3, dirty: false, pushed: false } })))
      .toBe('Behind master by 3 commits');
  });
  test('works even when local state is clean (the headline bug)', () => {
    // The operator's complaint: after a real merge on master, the dock kept
    // saying "No changes" — because local.behind wasn't fresh AND there
    // was no surface for it. Now the dock shows "Behind master by N" even
    // in `clean` state, which is exactly when this needs to be loud.
    const s = status({ state: 'clean', local: { isRepo: true, ahead: 0, behind: 7, dirty: false, pushed: false } });
    expect(behindBaseLabel(s)).toBe('Behind master by 7 commits');
  });
  test('non-master base (e.g. develop) is named correctly', () => {
    expect(behindBaseLabel(status({ base: 'develop', local: { isRepo: true, ahead: 2, behind: 4, dirty: false, pushed: false } })))
      .toBe('Behind develop by 4 commits');
  });
});
