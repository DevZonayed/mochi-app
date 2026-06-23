/* GitService — the per-session git/PR status brain (main process). Composes the
   pure git + github helpers, caches results, and emits `git-status` events. The
   token is read from the Keychain via Providers and never leaves this process. */

import { existsSync } from 'node:fs';
import type { Store, ChatSession, Project } from './store.js';
import type { Providers } from './providers.js';
import { isGitRepo, repoInfo, aheadBehind, isDirty, localRefExists, resolveBaseBranch, pushBranch, fetchOrigin, mergeBaseIntoBranch, renameLocalBranch, branchSlug, listConflictedFiles, dirtyFileCount, lastCommitInfo, getActiveConflictHunks, type ConflictFile } from './git.js';
import { parseGitHubRemote, findOpenPr, findRecentPr, getPullStatus, createPull, mergePull, getRepo, pickMergeMethod } from './github.js';
import { deriveState, type LocalState, type LocalSnapshot, type PrStatus, type SessionGitStatus, type MergePreviewResult, type ResolvePreviewResult } from './pr-state.js';

type Emit = (name: string, data: unknown, opts?: { live?: boolean; desktopOnly?: boolean }) => void;
const EMPTY_LOCAL: LocalState = { isRepo: false, ahead: 0, behind: 0, dirty: false, pushed: false };

export class GitService {
  private cache = new Map<string, SessionGitStatus>();

  constructor(private store: Store, private emit: Emit, private providers: Providers) {}

  private token(): string | undefined { return this.providers.getLocalKey('github'); }

  private dirFor(session: ChatSession, project: Project): string | null {
    if (session.worktreePath && existsSync(session.worktreePath)) return session.worktreePath;
    return project.path && isGitRepo(project.path) ? project.path : null;
  }

  /** Cheap local git facts (no network). */
  localState(session: ChatSession, project: Project): LocalState {
    const dir = this.dirFor(session, project);
    if (!dir) return EMPTY_LOCAL;
    const base = session.baseBranch ?? resolveBaseBranch(dir);
    const branch = session.branch ?? repoInfo(dir).branch ?? null;
    const { ahead, behind } = aheadBehind(dir, base);
    const originRef = branch ? `origin/${branch}` : null;
    const pushed = !!originRef && localRefExists(dir, originRef) && aheadBehind(dir, originRef).ahead === 0;
    return { isRepo: true, ahead, behind, dirty: isDirty(dir), pushed };
  }

  /** Live PR facts from GitHub.
   *
   *  Returns the OPEN PR for this branch when one exists. If no open PR exists,
   *  falls back to the MOST RECENT PR (open / merged / closed) so a finished
   *  lifecycle (`pr-merged`, `pr-closed`) still surfaces in the UI instead of
   *  collapsing to `ready-for-pr`. This fixes the "PR was squash-merged but the
   *  UI still says Create PR / shows 50 ahead" bug.
   *
   *  Returns null only when there's no token, no remote, or the branch has
   *  literally never had a PR. */
  async prState(session: ChatSession, project: Project): Promise<PrStatus | null> {
    const token = this.token();
    if (!token || !project.path || !session.branch) return null;
    const gh = parseGitHubRemote(repoInfo(project.path).remote);
    if (!gh) return null;
    try {
      const open = await findOpenPr(token, gh.owner, gh.repo, session.branch);
      if (open) return await getPullStatus(token, gh.owner, gh.repo, open.number);
      // No open PR → fall back to the most recent one (regardless of state) so
      // merged/closed PRs still report their state instead of returning null.
      const recent = await findRecentPr(token, gh.owner, gh.repo, session.branch);
      if (!recent) return null;
      return await getPullStatus(token, gh.owner, gh.repo, recent.number);
    } catch {
      return this.cache.get(session.id)?.pr ?? null; // keep last known on transient error
    }
  }

  /** Last-commit + dirty-file snapshot, populated for repos only. The
      dock surfaces this in its expanded body; absent on no-repo. */
  private snapshotFor(dir: string | null): LocalSnapshot | undefined {
    if (!dir) return undefined;
    const { subject, at } = lastCommitInfo(dir);
    return { lastSubject: subject, lastCommitAt: at, dirtyFiles: dirtyFileCount(dir) };
  }

  /** Compute (optionally with a live PR fetch), cache, and emit the status. */
  async fullStatus(session: ChatSession, opts: { withPr?: boolean } = {}): Promise<SessionGitStatus> {
    const project = this.store.getProject(session.projectId);
    const cached = this.cache.get(session.id);
    const local = project ? this.localState(session, project) : EMPTY_LOCAL;
    let pr = cached?.pr ?? null;
    const didCheckPr = !!opts.withPr && !!project;
    if (didCheckPr) pr = await this.prState(session, project!);
    // Sticky: once we've queried GitHub for this session, every later cheap
    // recompute (file-watcher, local-only poll) keeps `prChecked` true so the
    // overview strip doesn't flip the row back to a PR-unaware guess.
    const prChecked = didCheckPr || (cached?.prChecked ?? false);
    const dir = project ? this.dirFor(session, project) : null;
    const base = session.baseBranch ?? (dir ? resolveBaseBranch(dir) : null);
    const status: SessionGitStatus = {
      sessionId: session.id,
      branch: session.branch ?? null,
      base,
      local,
      pr,
      state: deriveState(local, pr),
      lastCheckedAt: Date.now(),
      prChecked,
      snapshot: this.snapshotFor(dir),
    };
    this.cache.set(session.id, status);
    this.emit('git-status', status);
    return status;
  }

  /** Push the session branch (authenticated via the Keychain token over HTTPS). */
  async pushSession(session: ChatSession): Promise<{ ok: boolean; reason?: string }> {
    const project = this.store.getProject(session.projectId);
    const dir = project ? this.dirFor(session, project) : null;
    if (!dir || !session.branch) return { ok: false, reason: 'no worktree or branch for this session' };
    const res = pushBranch(dir, session.branch, { token: this.token() });
    await this.fullStatus(session, { withPr: false });
    return res;
  }

  /** Push (if needed) then open a PR — or return the existing open one (idempotent). */
  async createPr(session: ChatSession, opts: { title?: string; body?: string; base?: string } = {}): Promise<{ ok: boolean; url?: string; number?: number; reason?: string }> {
    const project = this.store.getProject(session.projectId);
    const token = this.token();
    if (!project?.path || !session.branch) return { ok: false, reason: 'no repo or branch' };
    if (!token) return { ok: false, reason: 'connect GitHub first' };
    const gh = parseGitHubRemote(repoInfo(project.path).remote);
    if (!gh) return { ok: false, reason: 'this project has no GitHub remote' };
    const dir = this.dirFor(session, project) ?? project.path;
    const push = pushBranch(dir, session.branch, { token });
    if (!push.ok) return { ok: false, reason: push.reason };
    try {
      const existing = await findOpenPr(token, gh.owner, gh.repo, session.branch);
      if (existing) { await this.fullStatus(session, { withPr: true }); return { ok: true, url: existing.url, number: existing.number }; }
      const base = opts.base ?? session.baseBranch ?? resolveBaseBranch(dir);
      const pr = await createPull(token, gh.owner, gh.repo, { head: session.branch, base, title: opts.title ?? session.title, body: opts.body ?? '' });
      await this.fullStatus(session, { withPr: true });
      return { ok: true, url: pr.url, number: pr.number };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'create PR failed' };
    }
  }

  /** Merge the session's open PR (picks an allowed method unless one is given). */
  async mergePr(session: ChatSession, opts: { method?: 'merge' | 'squash' | 'rebase' } = {}): Promise<{ ok: boolean; reason?: string }> {
    const project = this.store.getProject(session.projectId);
    const token = this.token();
    if (!project?.path || !session.branch) return { ok: false, reason: 'no repo or branch' };
    if (!token) return { ok: false, reason: 'connect GitHub first' };
    const gh = parseGitHubRemote(repoInfo(project.path).remote);
    if (!gh) return { ok: false, reason: 'this project has no GitHub remote' };
    try {
      const open = await findOpenPr(token, gh.owner, gh.repo, session.branch);
      if (!open) return { ok: false, reason: 'no open PR for this session' };
      let method = opts.method;
      if (!method) { try { method = pickMergeMethod(await getRepo(token, gh.owner, gh.repo)); } catch { method = 'merge'; } }
      const res = await mergePull(token, gh.owner, gh.repo, open.number, method);
      await this.fullStatus(session, { withPr: true });
      return { ok: res.merged, reason: res.merged ? undefined : 'GitHub declined the merge' };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'merge failed' };
    }
  }

  /** READ-ONLY preview of what `mergePr` would do — used to render the human
      confirmation dialog. Never mutates anything (no GitHub merge, no push).
      Picks the same merge method `mergePr` would default to (or falls back to
      'unknown' when the repo info call fails, so the dialog can still render). */
  async previewMergePr(session: ChatSession, opts: { method?: 'merge' | 'squash' | 'rebase' } = {}): Promise<MergePreviewResult> {
    const project = this.store.getProject(session.projectId);
    const token = this.token();
    if (!project?.path || !session.branch) return { ok: false, reason: 'no repo or branch' };
    if (!token) return { ok: false, reason: 'connect GitHub first' };
    const gh = parseGitHubRemote(repoInfo(project.path).remote);
    if (!gh) return { ok: false, reason: 'this project has no GitHub remote' };
    try {
      const open = await findOpenPr(token, gh.owner, gh.repo, session.branch);
      if (!open) return { ok: false, reason: 'no open PR for this session' };
      const status = await getPullStatus(token, gh.owner, gh.repo, open.number);
      let method: 'merge' | 'squash' | 'rebase' | 'unknown';
      if (opts.method) method = opts.method;
      else {
        try { method = pickMergeMethod(await getRepo(token, gh.owner, gh.repo)); }
        catch { method = 'unknown'; }
      }
      return {
        ok: true,
        preview: {
          prNumber: status.number,
          prTitle: status.title,
          prUrl: status.url,
          mergeMethod: method,
          headSha: open.headSha,
          mergeable: status.mergeable,
          mergeableState: status.mergeableState,
          checks: status.checks,
        },
      };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'preview failed' };
    }
  }

  /** READ-ONLY preview of what `resolveSession` would do. Inspects the
      worktree for existing conflict markers + reads the open PR (if any) so
      the confirm dialog can list what will change. Never modifies the worktree. */
  async previewResolveSession(session: ChatSession): Promise<ResolvePreviewResult> {
    const project = this.store.getProject(session.projectId);
    const dir = project ? this.dirFor(session, project) : null;
    if (!dir || !session.branch) return { ok: false, reason: 'no worktree or branch' };
    const base = session.baseBranch ?? resolveBaseBranch(dir);
    const conflictedFiles = listConflictedFiles(dir);
    let prNumber: number | null = null;
    let prTitle: string | null = null;
    let prUrl: string | null = null;
    const token = this.token();
    if (token && project?.path) {
      const gh = parseGitHubRemote(repoInfo(project.path).remote);
      if (gh) {
        try {
          const open = await findOpenPr(token, gh.owner, gh.repo, session.branch);
          if (open) { prNumber = open.number; prTitle = open.title; prUrl = open.url; }
        } catch { /* best effort — preview still works without PR info */ }
      }
    }
    return {
      ok: true,
      preview: {
        prNumber,
        prTitle,
        prUrl,
        base,
        branch: session.branch,
        conflictedFiles,
      },
    };
  }

  /** T8: enumerate the conflict hunks currently live in this session's
      worktree (an in-progress merge from `resolveSession`, or a manual
      `git merge` the operator started). Pure read — no merge, no commit.
      Returns `{ files: [] }` for no worktree / no conflicts. */
  getConflictHunks(session: ChatSession): { files: ConflictFile[]; reason?: string } {
    const project = this.store.getProject(session.projectId);
    const dir = project ? this.dirFor(session, project) : null;
    if (!dir) return { files: [], reason: 'no worktree' };
    return getActiveConflictHunks(dir);
  }

  /** Merge the latest base into the session's worktree branch. Clean → push (the
      PR recomputes to mergeable); conflicts → leave them in the worktree for the
      operator/agent to resolve, returning the conflicted files. */
  async resolveSession(session: ChatSession): Promise<{ ok: boolean; conflicts: string[]; reason?: string }> {
    const project = this.store.getProject(session.projectId);
    const dir = project ? this.dirFor(session, project) : null;
    if (!dir || !session.branch) return { ok: false, conflicts: [], reason: 'no worktree or branch' };
    const base = session.baseBranch ?? resolveBaseBranch(dir);
    fetchOrigin(dir);
    const res = mergeBaseIntoBranch(dir, base);
    if (res.ok) pushBranch(dir, session.branch, { token: this.token() });
    await this.fullStatus(session, { withPr: true });
    return res;
  }

  /** Auto-rename hook: swap the codename-only initial branch for one carrying
      a task-derived slug (e.g. `mochi/lyon/lyon` → `mochi/lyon/fix-auth-bug`).
      Fires exactly once per session — gated by `branchRenamedAt`. Refuses
      after a PR exists on the old name (branch is locked to GitHub) and after
      the branch has been pushed (avoids dangling remote refs).

      Returns `{ ok:true, unchanged:true }` for no-op cases (already renamed,
      no branch, no codename, slug == codename, PR exists, branch pushed) so
      the caller can fire-and-forget without branching on the reason.

      Safe to call multiple times; only the first call where conditions allow
      will actually run `git branch -m`. */
  async renameSessionBranch(session: ChatSession): Promise<{ ok: boolean; from?: string; to?: string; unchanged?: boolean; reason?: string }> {
    if (session.branchRenamedAt) return { ok: true, unchanged: true, reason: 'already renamed' };
    if (!session.branch || !session.codename || !session.worktreePath) return { ok: true, unchanged: true, reason: 'no worktree branch' };
    const project = this.store.getProject(session.projectId);
    if (!project?.path) return { ok: true, unchanged: true, reason: 'no project path' };

    const slug = branchSlug(session.title);
    // If the slug is still the codename or empty, the title hasn't ripened.
    if (!slug || slug === session.codename || slug === 'chat') return { ok: true, unchanged: true, reason: 'title not informative yet' };

    const to = `mochi/${session.codename}/${slug}`;
    if (to === session.branch) {
      // Already aligned — just mark it renamed so we don't keep evaluating.
      try { this.store.updateSession(session.id, { branchRenamedAt: Date.now() }); } catch { /* gone */ }
      return { ok: true, unchanged: true };
    }

    // Lock once the branch has been pushed or a PR exists — renaming the
    // remote/PR head is destructive and outside the scope of this hook.
    const cached = this.cache.get(session.id);
    if (cached?.local.pushed) {
      try { this.store.updateSession(session.id, { branchRenamedAt: Date.now() }); } catch { /* gone */ }
      return { ok: true, unchanged: true, reason: 'branch already pushed' };
    }
    if (cached?.pr) {
      try { this.store.updateSession(session.id, { branchRenamedAt: Date.now() }); } catch { /* gone */ }
      return { ok: true, unchanged: true, reason: 'PR exists' };
    }

    const res = renameLocalBranch(session.worktreePath, session.branch, to);
    if (!res.ok) return { ok: false, from: session.branch, to, reason: res.reason };

    try { this.store.updateSession(session.id, { branch: to, branchRenamedAt: Date.now() }); } catch { /* gone */ }
    // Re-emit status with the new branch name.
    try { await this.fullStatus({ ...session, branch: to, branchRenamedAt: Date.now() }, { withPr: false }); } catch { /* best effort */ }
    return { ok: true, from: session.branch, to, unchanged: res.unchanged };
  }

  /** Sessions worth polling for PR state (have a branch + live worktree, not archived). */
  pollable(): ChatSession[] {
    return this.store.listSessions().filter(s => !!s.branch && !!s.worktreePath && !s.archivedAt);
  }
}
