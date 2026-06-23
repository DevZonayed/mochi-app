/* GitWatcher — file-system watcher that turns a session's `.git` directory into
   a stream of `git-status` events on the renderer's existing SSE/event channel.

   Why a watcher (and not a poll): the existing per-session PR poller is
   network-bound (GitHub) and runs on a 30-60s cadence. Local git facts
   (HEAD moved, index touched, branch ref bumped, merge marker set) flip the
   `SessionGitState` on a sub-second timescale — every `git commit`, `git
   add`, `git push`, `git pull`, `git merge` mutates one of these files —
   and the UI was missing the event entirely until the next poll.

   What we watch, per session worktree:
     • .git/HEAD                — branch switch (post-checkout)
     • .git/index               — stage/unstage (post-add)
     • .git/refs/heads/<branch> — commit on that branch (post-commit, push)
     • .git/ORIG_HEAD           — post-merge marker (set by git merge)

   `.git` in a worktree is actually a file (`gitdir: …`) pointing into the
   main repo's `.git/worktrees/<name>/`. We resolve that once on attach so
   the file paths are correct.

   Debounce: a single `git commit` mutates HEAD + index + the branch ref —
   three events in <50ms. We coalesce into a single `fullStatus()` recompute
   after `DEBOUNCE_MS` (250ms) of quiet.

   Lifecycle:
     • attach(sessionId): starts the watcher (idempotent — call twice = no-op).
     • detach(sessionId): stops + closes all watchers (called from prune).
     • detachAll(): app-shutdown cleanup. */

import { existsSync, readFileSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';
import type { GitService } from './git-service.js';

const DEBOUNCE_MS = 250;

/** Minimal `fs.watch` interface so tests can pass a fake without spinning real OS watchers. */
export type WatchFn = (
  filename: string,
  listener: (event: string, filename: string | Buffer | null) => void,
) => FSWatcher;

/** Resolve the `.git` directory for a worktree. In a linked worktree, the
    on-disk `.git` is a FILE containing `gitdir: <abs-path>`; in the main
    checkout it's a directory. Returns null when neither shape is present. */
export function resolveGitDir(worktreePath: string): string | null {
  const dotGit = path.join(worktreePath, '.git');
  if (!existsSync(dotGit)) return null;
  let text: string;
  try { text = readFileSync(dotGit, 'utf8'); } catch { return dotGit; } // it's a directory
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return dotGit;
  // The pointer may be absolute or relative to the worktree.
  const p = m[1].trim();
  return path.isAbsolute(p) ? p : path.resolve(worktreePath, p);
}

/** The four files (per session) whose change should trigger a recompute.
    Branch is optional — when null we skip the per-branch ref watcher. */
export function trackedFiles(gitDir: string, branch: string | null): string[] {
  const files = [
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'index'),
    path.join(gitDir, 'ORIG_HEAD'),
  ];
  if (branch) {
    // Packed-refs ALSO flips on push, but watching it would re-emit on every
    // other branch's push too. The per-branch loose ref covers commit + push
    // for THIS session's branch cleanly.
    files.push(path.join(gitDir, 'refs', 'heads', branch));
  }
  return files;
}

export interface GitWatcherOptions {
  /** Override `fs.watch` for tests. */
  watch?: WatchFn;
  /** Override the debounce window for tests. */
  debounceMs?: number;
  /** Override the worktree → .git resolver for tests. */
  resolveGitDir?: (worktreePath: string) => string | null;
}

interface SessionAttachment {
  worktreePath: string;
  branch: string | null;
  watchers: FSWatcher[];
  timer: NodeJS.Timeout | null;
}

/** Per-session git filesystem watcher. Composed (not extended) by the dispatcher
    so it can be mocked in tests + closed cleanly on app shutdown. */
export class GitWatcher {
  private readonly attached = new Map<string, SessionAttachment>();
  private readonly watch: WatchFn;
  private readonly debounceMs: number;
  private readonly resolve: (worktreePath: string) => string | null;

  constructor(
    private store: Store,
    private gitService: GitService,
    opts: GitWatcherOptions = {},
  ) {
    this.watch = opts.watch ?? fsWatch;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.resolve = opts.resolveGitDir ?? resolveGitDir;
  }

  /** Idempotent: a second attach with the same branch is a no-op. If the
      branch CHANGED (auto-rename) we detach + re-attach so the per-branch
      ref watcher tracks the new file. */
  attach(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    if (!session.worktreePath || !existsSync(session.worktreePath)) return;

    const existing = this.attached.get(sessionId);
    if (existing) {
      if (existing.worktreePath === session.worktreePath && existing.branch === (session.branch ?? null)) return;
      this.detach(sessionId);
    }

    const gitDir = this.resolve(session.worktreePath);
    if (!gitDir) return;

    const files = trackedFiles(gitDir, session.branch ?? null);
    const watchers: FSWatcher[] = [];
    const att: SessionAttachment = { worktreePath: session.worktreePath, branch: session.branch ?? null, watchers, timer: null };

    for (const f of files) {
      try {
        const w = this.watch(f, () => this.kick(sessionId));
        // Don't take down the dispatcher when a file vanishes / is replaced
        // (git frequently atomic-swaps refs); just stop watching that one.
        w.on?.('error', () => { try { w.close(); } catch { /* ignore */ } });
        watchers.push(w);
      } catch {
        // Missing file is fine — `index` doesn't exist on a brand-new repo,
        // `ORIG_HEAD` only exists after a merge. The other watchers carry it.
      }
    }
    this.attached.set(sessionId, att);
  }

  /** Idempotent close + delete; safe to call from prune hooks regardless of state. */
  detach(sessionId: string): void {
    const att = this.attached.get(sessionId);
    if (!att) return;
    if (att.timer) clearTimeout(att.timer);
    for (const w of att.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.attached.delete(sessionId);
  }

  /** App-shutdown: close everything (registered by main.ts on `before-quit`). */
  detachAll(): void {
    for (const id of Array.from(this.attached.keys())) this.detach(id);
  }

  /** True when this session has a live watcher — used by tests + the dispatcher. */
  has(sessionId: string): boolean { return this.attached.has(sessionId); }

  /** Test seam: read the current attachment count. */
  size(): number { return this.attached.size; }

  /** Coalesce a burst of file events into a single `fullStatus()` call.
      `withPr:false` is cheap (no network) — the next PR poll upgrades it. */
  private kick(sessionId: string): void {
    const att = this.attached.get(sessionId);
    if (!att) return;
    if (att.timer) clearTimeout(att.timer);
    att.timer = setTimeout(() => {
      att.timer = null;
      const s = this.store.getSession(sessionId);
      if (!s) { this.detach(sessionId); return; }
      // Best-effort: a recompute failure shouldn't kill the watcher.
      this.gitService.fullStatus(s, { withPr: false }).catch(() => { /* ignore */ });
    }, this.debounceMs);
  }
}
