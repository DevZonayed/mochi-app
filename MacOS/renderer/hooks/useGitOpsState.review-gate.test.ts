import { describe, expect, it } from 'vitest';
import { actionsFor, applyReviewGateToActions, runGitOpsAction, type GitOpsAction } from './useGitOpsState';

describe('GitOps review gate blocking', () => {
  it('blocked actions refuse before calling API dispatch', async () => {
    const push = { ...actionsFor('ready-to-push')[0], blockedReason: 'review gate blocked: malformed result' } as GitOpsAction;
    await expect(runGitOpsAction(push, {
      sessionId: 's',
      branch: 'b',
      base: 'main',
      local: { isRepo: true, ahead: 1, behind: 0, dirty: false, pushed: false },
      pr: null,
      state: 'ready-to-push',
      lastCheckedAt: Date.now(),
      prChecked: false,
    })).resolves.toEqual({ ok: false, reason: 'review gate blocked: malformed result' });
  });

  it('does not treat review-gate fetch failure as unblocked null', async () => {
    const projected = applyReviewGateToActions(actionsFor('ready-to-push'), {
      state: 'error',
      gate: null,
      reason: 'Review status unavailable',
    });
    expect(projected.reviewBlocked).toBe(true);
    expect(projected.reviewLabel).toBe('Review status unavailable');
    expect(projected.actions[0].blockedReason).toBe('Review status unavailable');
  });
});
