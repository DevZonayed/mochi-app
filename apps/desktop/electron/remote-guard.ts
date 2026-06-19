/* The security boundary for ANY remote surface (relay OR direct P2P).

   `dispatch` is shared with the local desktop IPC, but a remote (phone / web /
   P2P peer) is a read-mostly remote control — never a local-execution surface.
   These methods expose local secrets or run local file/git/extension actions and
   must never answer to a remote, regardless of transport. Both the relay path and
   the P2P path funnel through this one set so they can't drift apart. */

export const REMOTE_BLOCKED_METHODS: ReadonlySet<string> = new Set<string>([
  // device/pairing control (raw token, kick, code rotation) — this Mac only
  'getPairing', 'kickDevice', 'regeneratePairingCode',
  // project memory + git/worktree/PR actions read/write local files & run git
  'getProjectMemory', 'setProjectMemory', 'snapshotProject', 'archiveSessionWorktree',
  'importGithubFromCli', 'getSessionGitStatus', 'refreshSessionGitStatus',
  'pushSession', 'createSessionPR', 'mergeSessionPR', 'resolveSession',
  // design comments live in local project files
  'listDesignComments', 'addDesignComment', 'setDesignCommentStatus', 'deleteDesignComment',
  // native browser extension control + design→code copy
  'extensionStatus', 'extensionSetActive', 'copyDesignToCode',
  // local skill files + on-disk conversation import
  'addSkillToProject', 'removeSkillFromProject', 'scanConversations', 'importConversations',
  // feedbackCreateIssue spends THIS Mac's GitHub token (a remote may submit/list/triage, not file)
  'feedbackCreateIssue',
  // WhatsApp chat content + sending live on this Mac's Baileys socket — a remote must
  // never read messages, download media, or send on the linked number over the wire.
  'waListChats', 'waGetMessages', 'waChatInfo', 'waSendText', 'waSendMedia', 'waReact',
  'waMarkRead', 'waSetTyping', 'waFetchAvatar', 'waDownloadMedia',
  'addProjectWaChat', 'removeProjectWaChat', 'listProjectWaChats',
  'setWhatsappAgentSend', 'setWhatsappRecipient',
]);

/** True if `method` must NOT answer to a remote (relay or P2P). */
export function isRemoteBlocked(method: string): boolean {
  return REMOTE_BLOCKED_METHODS.has(method);
}
