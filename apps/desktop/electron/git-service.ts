/* GitService — the per-session git/PR status brain (main process). Composes the
   pure git + github helpers, caches results, and emits `git-status` events. The
   token is read from the Keychain via Providers and never leaves this process. */

import { existsSync } from 'node:fs';
import type { Store, ChatSession, Project } from './store.js';
import type { Providers } from './providers.js';
import { isGitRepo, repoInfo, aheadBehind, isDirty, localRefExists, resolveBaseBranch } from './git.js';
import { parseGitHubRemote, findOpenPr, getPullStatus } from './github.js';
import { deriveState, type LocalState, type PrStatus, type SessionGitStatus } from './pr-state.js';

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

  /** Live PR facts from GitHub (null when no token / non-GitHub / no open PR). */
  async prState(session: ChatSession, project: Project): Promise<PrStatus | null> {
    const token = this.token();
    if (!token || !project.path || !session.branch) return null;
    const gh = parseGitHubRemote(repoInfo(project.path).remote);
    if (!gh) return null;
    try {
      const open = await findOpenPr(token, gh.owner, gh.repo, session.branch);
      if (!open) return null;
      return await getPullStatus(token, gh.owner, gh.repo, open.number);
    } catch {
      return this.cache.get(session.id)?.pr ?? null; // keep last known on transient error
    }
  }

  /** Compute (optionally with a live PR fetch), cache, and emit the status. */
  async fullStatus(session: ChatSession, opts: { withPr?: boolean } = {}): Promise<SessionGitStatus> {
    const project = this.store.getProject(session.projectId);
    const local = project ? this.localState(session, project) : EMPTY_LOCAL;
    let pr = this.cache.get(session.id)?.pr ?? null;
    if (opts.withPr && project) pr = await this.prState(session, project);
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
    };
    this.cache.set(session.id, status);
    this.emit('git-status', status);
    return status;
  }

  /** Sessions worth polling for PR state (have a branch + live worktree, not archived). */
  pollable(): ChatSession[] {
    return this.store.listSessions().filter(s => !!s.branch && !!s.worktreePath && !s.archivedAt);
  }
}
