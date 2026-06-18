import { describe, it, expect } from 'vitest';
import { isRemoteBlocked, REMOTE_BLOCKED_METHODS } from './remote-guard.js';

describe('remote-guard', () => {
  it('blocks every local-secret / local-execution method', () => {
    // Regression guard: these MUST stay blocked on any remote transport.
    const mustBlock = [
      'getPairing', 'kickDevice', 'regeneratePairingCode',
      'getProjectMemory', 'setProjectMemory', 'snapshotProject', 'archiveSessionWorktree',
      'importGithubFromCli', 'getSessionGitStatus', 'refreshSessionGitStatus',
      'pushSession', 'createSessionPR', 'mergeSessionPR', 'resolveSession',
      'listDesignComments', 'addDesignComment', 'setDesignCommentStatus', 'deleteDesignComment',
      'extensionStatus', 'extensionSetActive', 'copyDesignToCode',
      'addSkillToProject', 'removeSkillFromProject', 'scanConversations', 'importConversations',
      'feedbackCreateIssue',
    ];
    for (const m of mustBlock) expect(isRemoteBlocked(m)).toBe(true);
    expect(REMOTE_BLOCKED_METHODS.size).toBe(mustBlock.length);
  });

  it('allows ordinary remote-control methods', () => {
    for (const m of ['sendChat', 'runJob', 'createProject', 'approveApproval', 'submitFeedback', 'generateAsset']) {
      expect(isRemoteBlocked(m)).toBe(false);
    }
  });
});
