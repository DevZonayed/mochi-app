/* The in-process bridge behind the agent's git/PR tools (mcp__maestro__git_*,
   pr_*). Pure shim over GitService for ONE session — so when the user says
   "create the PR" / "merge it" / "resolve the conflicts" in chat, the agent
   actually drives the same code paths the chat header buttons do.

   Why a per-session ctx (not pass GitService directly): the agent never picks
   WHICH session to act on; it always acts on the open chat. This shim binds
   the session id once, so every tool call is guaranteed to target the current
   chat (no impersonation risk if the agent tries to set `sessionId` to
   something else).

   ── HUMAN-CONFIRM GATE (pr_merge + pr_resolve_conflicts) ──
   `mergePr` and `resolveConflicts` ALWAYS return `{ needsConfirm: true,
   preview }` — they never actually merge or resolve. The destructive code
   path lives in `gitService.mergePr` / `gitService.resolveSession` and is
   reached EXCLUSIVELY through the renderer's IPC handlers
   (`mergeSessionPR` / `resolveSession` in `localApi.ts`), which run only
   after the operator clicks Confirm in `<PrActionConfirmDialog />`.

   A `confirmed: true` flag arriving via GitCtx is a tripwire — we strip + log
   it and fall back to the preview gate. The operator's "11 unauthorized
   squash-merges" incident is why this defense-in-depth check exists: even if
   a future refactor accidentally routes an agent call through here with the
   flag set, we never merge. Agent paths in engine.ts (Claude) and
   codex-bridge.ts (Codex) emit a `pr-confirm-request` event so the renderer
   can show the dialog, and the renderer re-invokes the action via the IPC
   handlers (which use `gitService` directly, not this object).

   Pure logic — no MCP / electron deps — so it's unit-testable in isolation. */

import type { Store, ChatSession } from './store.js';
import type { GitService } from './git-service.js';
import { isGitRepo, repoInfo, structuredDiff } from './git.js';
import { parseGitHubRemote } from './github.js';
import type { SessionGitStatus, MergePreview, ResolvePreview } from './pr-state.js';

// Re-export the preview types so callers can import them from `git-ctx.js`
// alongside the rest of the per-session ctx surface.
export type { MergePreview, ResolvePreview } from './pr-state.js';

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

/** Returned when a destructive action is called without `confirmed: true`. */
export interface MergeNeedsConfirm { needsConfirm: true; action: 'pr_merge'; preview: MergePreview }
export interface ResolveNeedsConfirm { needsConfirm: true; action: 'pr_resolve_conflicts'; preview: ResolvePreview }

/** Discriminated unions so TS narrows on `'needsConfirm' in r`. The "ran" branch
 *  explicitly excludes the `needsConfirm` key (typed as `never | undefined`). */
export type MergePrResult = MergeNeedsConfirm | { needsConfirm?: undefined; ok: boolean; reason?: string };
export type ResolveConflictsResult = ResolveNeedsConfirm | { needsConfirm?: undefined; ok: boolean; conflicts: string[]; reason?: string };

/** User-defined type guard: did we get a needs-confirm response? */
export function isNeedsConfirm<T extends { needsConfirm?: unknown }>(r: T): r is T & { needsConfirm: true } {
  return (r as { needsConfirm?: unknown }).needsConfirm === true;
}

export interface MergePrOpts {
  method?: 'merge' | 'squash' | 'rebase';
  /** TRIPWIRE: this flag is rejected (stripped + console.warn) if it ever
      reaches GitCtx. The renderer's `mergeSessionPR` IPC handler bypasses
      GitCtx entirely and calls `gitService.mergePr` directly, so a
      `confirmed: true` arriving here means someone is trying to merge
      through the agent surface — which we never allow. Kept on the type
      for API stability + so the tripwire's intent is explicit. */
  confirmed?: boolean;
}

export interface ResolveConflictsOpts {
  /** TRIPWIRE: same as MergePrOpts.confirmed — renderer must use the
      `resolveSession` IPC handler (which calls `gitService.resolveSession`
      directly); a `confirmed: true` reaching GitCtx is logged + dropped. */
  confirmed?: boolean;
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
  /** Merge the open PR with the repo's preferred merge method.
   *
   *  GATED: returns `{ needsConfirm: true, preview }` unless opts.confirmed === true.
   *  Only the renderer (via IPC) is allowed to pass confirmed; agent paths must
   *  strip the flag before calling (engine.ts + codex-bridge.ts handle that). */
  mergePr(opts?: MergePrOpts): Promise<MergePrResult>;
  /** Pull the base branch in. Returns conflicted files when the agent must
      resolve markers by hand (Read/Edit/commit, then call again to verify).
   *
   *  GATED: returns `{ needsConfirm: true, preview }` unless opts.confirmed === true. */
  resolveConflicts(opts?: ResolveConflictsOpts): Promise<ResolveConflictsResult>;
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

    async mergePr(opts) {
      // GATE + TRIPWIRE: only the renderer's IPC handler in localApi.ts may
      // call gitService.mergePr directly (it bypasses this object entirely).
      // GitCtx — the agent's surface — must ALWAYS preview. Even if a future
      // refactor accidentally routes an agent call through here with
      // `confirmed: true`, we strip + log + refuse instead of merging. The
      // operator's screenshot of 11 unauthorized squash-merges is the reason
      // this defense-in-depth check exists. Do NOT downgrade to a silent
      // pass-through.
      if (opts?.confirmed === true) {
        // eslint-disable-next-line no-console
        console.warn('[git-ctx] TRIPWIRE: pr_merge called with confirmed:true via the agent path. Stripping the flag and falling back to the preview gate. The renderer must call gitService.mergePr directly via the mergeSessionPR IPC handler.');
      }
      const prev = await gitService.previewMergePr(session, { method: opts?.method });
      if (!prev.ok) return { ok: false, reason: prev.reason };
      return { needsConfirm: true, action: 'pr_merge', preview: prev.preview };
    },

    async resolveConflicts(opts) {
      // GATE + TRIPWIRE: same shape as mergePr above — confirmed:true is a
      // renderer-only flag that should never arrive here. We strip + log.
      if (opts?.confirmed === true) {
        // eslint-disable-next-line no-console
        console.warn('[git-ctx] TRIPWIRE: pr_resolve_conflicts called with confirmed:true via the agent path. Stripping the flag and falling back to the preview gate. The renderer must call gitService.resolveSession directly via the resolveSession IPC handler.');
      }
      const prev = await gitService.previewResolveSession(session);
      if (!prev.ok) return { ok: false, conflicts: [], reason: prev.reason };
      return { needsConfirm: true, action: 'pr_resolve_conflicts', preview: prev.preview };
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
    case 'pr-merged':     return 'PR is merged — work is on base. Branch may still show "ahead" commits with different SHAs (squash-merge case): they\'re obsolete. Reset to base (Bash: git fetch origin <base>:<base> && git reset --hard origin/<base>) or archive the worktree.';
    case 'pr-closed':     return 'PR was closed without merging. The branch still exists locally; consider a new PR or abandoning the chat.';
  }
}
