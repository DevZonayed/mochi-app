/* The in-process bridge behind the agent's git/PR tools (mcp__maestro__git_*,
   pr_*). Pure shim over GitService for ONE session — so when the user says
   "create the PR" / "merge it" / "resolve the conflicts" in chat, the agent
   actually drives the same code paths the chat header buttons do.

   Why a per-session ctx (not pass GitService directly): the agent never picks
   WHICH session to act on; it always acts on the open chat. This shim binds
   the session id once, so every tool call is guaranteed to target the current
   chat (no impersonation risk if the agent tries to set `sessionId` to
   something else).

   Pure logic — no MCP / electron deps — so it's unit-testable in isolation. */

import type { Store, ChatSession } from './store.js';
import type { GitService } from './git-service.js';
import { isGitRepo, repoInfo, structuredDiff } from './git.js';
import { parseGitHubRemote } from './github.js';
import type { SessionGitStatus } from './pr-state.js';

export interface GitCtxStatus {
  branch: string | null;
  base: string | null;
  state: SessionGitStatus['state'];
  ahead: number;
  behind: number;
  dirty: boolean;
  pushed: boolean;
  pr: { number: number; url: string; title: string; mergeable: boolean | null; state: 'open' | 'closed' | 'merged' } | null;
  /** Short, human-friendly description of what to do next given the state. */
  nextAction: string;
}

export interface GitCtxConflictReport {
  ok: boolean;
  /** Worktree-relative paths that need conflict markers resolved. */
  conflicts: string[];
  reason?: string;
}

export interface GitCtx {
  /** Whether this session has a live worktree on a GitHub repo. Callers can
      gate UI / tool surface on this. */
  available(): boolean;
  /** Read-only status — `state` is the same 10-state machine the chip uses. */
  status(): Promise<GitCtxStatus>;
  /** Diff of every committed + uncommitted change vs the base branch. Truncated. */
  diffSummary(): { files: string[]; additions: number; deletions: number; truncated: boolean };
  /** Push the session branch to origin (auth via the saved GitHub token). */
  push(): Promise<{ ok: boolean; reason?: string }>;
  /** Open a PR (pushes first if needed). Idempotent — re-opens the existing one. */
  createPr(opts?: { title?: string; body?: string }): Promise<{ ok: boolean; url?: string; number?: number; reason?: string }>;
  /** Merge the open PR with the repo's preferred merge method. */
  mergePr(opts?: { method?: 'merge' | 'squash' | 'rebase' }): Promise<{ ok: boolean; reason?: string }>;
  /** Pull the base branch in. Returns conflicted files when the agent must
      resolve markers by hand (Read/Edit/commit, then call again to verify). */
  resolveConflicts(): Promise<GitCtxConflictReport>;
  /** Manual one-shot of the auto-rename hook. No-op when title is uninformative. */
  renameBranch(): Promise<{ ok: boolean; from?: string; to?: string; unchanged?: boolean; reason?: string }>;
}

/** Bind GitCtx to one session — captures session id so the agent can never
    point an op at the wrong chat. Pass `null` for non-chat / non-repo runs. */
export function makeGitCtx(store: Store, gitService: GitService, sessionId: string): GitCtx | null {
  const session = store.getSession(sessionId);
  if (!session) return null;
  const project = store.getProject(session.projectId);
  // Available iff we have a worktree, a branch, and a GitHub remote we recognize.
  const repoDir = project?.path && isGitRepo(project.path) ? project.path : null;
  const remote = repoDir ? repoInfo(repoDir).remote : null;
  const isGh = !!parseGitHubRemote(remote);
  const live = !!session.branch && !!session.worktreePath && !!repoDir;

  return {
    available: () => live && isGh,

    async status(): Promise<GitCtxStatus> {
      const full = await gitService.fullStatus(session, { withPr: true });
      const pr = full.pr ? {
        number: full.pr.number, url: full.pr.url, title: full.pr.title,
        mergeable: full.pr.mergeable, state: full.pr.state,
      } : null;
      return {
        branch: full.branch, base: full.base, state: full.state,
        ahead: full.local.ahead, behind: full.local.behind,
        dirty: full.local.dirty, pushed: full.local.pushed,
        pr,
        nextAction: nextActionFor(full.state),
      };
    },

    diffSummary() {
      const wt = session.worktreePath ?? repoDir;
      if (!wt) return { files: [], additions: 0, deletions: 0, truncated: false };
      const sd = structuredDiff(wt, session.baseBranch);
      return { files: sd.files.map(f => f.path), additions: sd.additions, deletions: sd.deletions, truncated: sd.truncated };
    },

    push() { return gitService.pushSession(session); },

    createPr(opts) {
      return gitService.createPr(session, opts);
    },

    mergePr(opts) {
      return gitService.mergePr(session, opts);
    },

    resolveConflicts() {
      return gitService.resolveSession(session);
    },

    renameBranch() {
      return gitService.renameSessionBranch(session);
    },
  };
}

/** Human-friendly hint about what to do next for each state. Kept here (not in
    the tool descriptions) so the agent gets it inside the tool's TEXT response,
    not just in the schema doc. */
export function nextActionFor(state: SessionGitStatus['state']): string {
  switch (state) {
    case 'no-repo':       return 'Not a git repo — nothing to do.';
    case 'clean':         return 'No changes yet. Make edits, then commit (Bash: git add -A && git commit -m "…").';
    case 'uncommitted':   return 'Working tree has uncommitted changes. Commit them with Bash (git add -A && git commit -m "…") before pushing.';
    case 'ready-to-push': return 'Local commits ready. Call git_push, then pr_create.';
    case 'ready-for-pr':  return 'Pushed and ahead of base. Call pr_create.';
    case 'pr-mergeable':  return 'PR is open and clean. Call pr_merge to land it.';
    case 'pr-conflicts':  return 'PR has conflicts. Call pr_resolve_conflicts — it will pull base in; if it returns conflicted files, read each, resolve the <<<<<<< markers, commit, and call again.';
    case 'pr-blocked':    return 'PR is open but blocked (checks pending or behind). Wait for checks; pull base via pr_resolve_conflicts if behind.';
    case 'pr-merged':     return 'PR has been merged — the lifecycle for this session is done. Use mcp__maestro__archiveSessionWorktree if you want to prune the worktree.';
    case 'pr-closed':     return 'PR was closed without merging. The branch still exists locally; consider a new PR or abandoning the chat.';
  }
}
