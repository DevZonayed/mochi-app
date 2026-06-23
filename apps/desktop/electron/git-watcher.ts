/* GitWatcher — file-system watcher that turns a session's `.git` directory into
   a stream of `git-status` events on the renderer's existing SSE/event channel.

   Why a watcher (and not a poll): the existing per-session PR poller is
   network-bound (GitHub) and runs on a 30-60s cadence. Local git facts
   (HEAD moved, index touched, branch ref bumped, merge marker set) flip the
   `SessionGitState` on a sub-second timescale — every `git commit`, `git
   add`, `git push`, `git pull`, `git merge` mutates one of these files —
   and the UI was missing the event entirely until the next poll.

   What we watch, per session worktree:
     • .git/HEAD                          — branch switch (post-checkout)
     • .git/index                         — stage/unstage (post-add)
     • .git/refs/heads/<branch>           — commit on that branch (post-commit, push)
     • .git/ORIG_HEAD                     — post-merge marker (set by git merge)
     • .git/refs/remotes/origin/<base>    — *** base branch moved on origin ***
                                            (this is how we detect "behind by N"
                                            after ANOTHER chat or the operator
                                            merges via GitHub — the next fetch
                                            updates this ref, and we recompute
                                            without waiting for the 30-60s PR
                                            poll)
     • .git/FETCH_HEAD                    — fallback signal that *some* fetch
                                            happened (covers detached / pruned
                                            ref cases)

   `.git` in a worktree is actually a file (`gitdir: …`) pointing into the
   main repo's `.git/worktrees/<name>/`. We resolve that once on attach so
   the file paths are correct. NOTE: refs/remotes/origin/<base> always lives
   in the MAIN gitdir (not the per-worktree gitdir) — git's refdb is global
   per repo. We resolve via `commondir` (the main gitdir) when a `.git/file`
   points into a worktree subdir.

   Debounce: a single `git commit` mutates HEAD + index + the branch ref —
   three events in <50ms. We coalesce into a single `fullStatus()` recompute
   after `DEBOUNCE_MS` (250ms) of quiet.

   Background fetch: every `FETCH_INTERVAL_MS` (default 5 minutes), the
   watcher kicks `git fetch --prune origin` from the session's worktree to
   keep refs/remotes/origin/<base> fresh. Skipped if a fetch ran in the
   last `FETCH_MIN_GAP_MS`. Tests can override via opts (no real `git`
   process is spawned in tests).

   Lifecycle:
     • attach(sessionId): starts the watcher (idempotent — call twice = no-op).
     • detach(sessionId): stops + closes all watchers (called from prune).
     • detachAll(): app-shutdown cleanup. */

import { existsSync, readFileSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Store } from './store.js';
import type { GitService } from './git-service.js';

const DEBOUNCE_MS = 250;
/** How often we run a background `git fetch` to refresh refs/remotes/origin/<base>. */
const FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/** Minimum gap between fetches per session (suppresses storm when the user
    actively pushes/pulls). */
const FETCH_MIN_GAP_MS = 60 * 1000; // 1 minute

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

/** Resolve the COMMON gitdir (the main repo's `.git`), which holds the global
    refdb — including `refs/remotes/origin/*`. In a linked worktree, the
    per-worktree gitdir contains a `commondir` file pointing to the main one
    (relative to the worktree's gitdir). In a main checkout the gitdir IS the
    commondir. Returns the gitDir itself on any read error (safe fallback —
    refs/remotes/origin/<base> may still live there in older repos). */
export function commonGitDir(gitDir: string): string {
  const cdf = path.join(gitDir, 'commondir');
  if (!existsSync(cdf)) return gitDir;
  try {
    const rel = readFileSync(cdf, 'utf8').trim();
    if (!rel) return gitDir;
    return path.isAbsolute(rel) ? rel : path.resolve(gitDir, rel);
  } catch { return gitDir; }
}

/** The files (per session) whose change should trigger a recompute. Branch +
    base are optional — when null we skip those ref watchers.

    `commonDir` is the main repo's gitdir (`refs/remotes/origin/*` lives there,
    not in the per-worktree gitdir). When null we fall back to `gitDir` for
    the remote ref so main-checkout sessions still work. */
export function trackedFiles(
  gitDir: string,
  branch: string | null,
  base: string | null = null,
  commonDir: string | null = null,
): string[] {
  const files = [
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'index'),
    path.join(gitDir, 'ORIG_HEAD'),
    // FETCH_HEAD lives in the per-worktree gitdir (each worktree records its
    // own last-fetch) — touching it on any fetch is our cheap signal that
    // refs/remotes may have moved, even if the per-base ref didn't.
    path.join(gitDir, 'FETCH_HEAD'),
  ];
  if (branch) {
    // Packed-refs ALSO flips on push, but watching it would re-emit on every
    // other branch's push too. The per-branch loose ref covers commit + push
    // for THIS session's branch cleanly.
    files.push(path.join(gitDir, 'refs', 'heads', branch));
  }
  if (base) {
    // *** The fix for "merge happened elsewhere, dock still says No changes" ***
    // refs/remotes/origin/<base> updates the instant `git fetch` (foreground
    // OR our background interval below) lands the new tip. Watching it means
    // a recompute fires within DEBOUNCE_MS of the ref bump — no waiting on
    // the 30-60s PR poller for `local.behind` to refresh.
    const commonRefRoot = commonDir ?? gitDir;
    files.push(path.join(commonRefRoot, 'refs', 'remotes', 'origin', base));
  }
  return files;
}

/** Pluggable fetcher — defaults to a real `git fetch --prune origin` in the
    session's worktree. Tests pass a vi.fn so no child process is spawned. */
export type FetchFn = (worktreePath: string) => Promise<void>;

const defaultFetch: FetchFn = (worktreePath) =>
  new Promise<void>((resolve) => {
    // Best-effort: a fetch failure (offline, auth, etc.) should not throw —
    // the watcher's reason for fetching is to keep refs/remotes/origin/<base>
    // fresh, and we'll get the next interval anyway.
    execFile('git', ['fetch', '--prune', '--quiet', 'origin'], {
      cwd: worktreePath,
      // Don't inherit any GIT_* env that pinned a different gitdir.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 30_000,
    }, () => resolve());
  });

export interface GitWatcherOptions {
  /** Override `fs.watch` for tests. */
  watch?: WatchFn;
  /** Override the debounce window for tests. */
  debounceMs?: number;
  /** Override the worktree → .git resolver for tests. */
  resolveGitDir?: (worktreePath: string) => string | null;
  /** Override the common-gitdir resolver for tests (linked-worktree refdb). */
  resolveCommonDir?: (gitDir: string) => string;
  /** Test seam: replace the real `git fetch` with a fake. */
  fetch?: FetchFn;
  /** Background fetch interval (default 5min). 0 disables the background
      timer entirely (used in unit tests so they don't spawn timers). */
  fetchIntervalMs?: number;
  /** Minimum gap between fetches per session (default 1min). */
  fetchMinGapMs?: number;
}

interface SessionAttachment {
  worktreePath: string;
  branch: string | null;
  base: string | null;
  watchers: FSWatcher[];
  timer: NodeJS.Timeout | null;
  /** Background-fetch interval handle (null when disabled). */
  fetchTimer: NodeJS.Timeout | null;
  /** Wall-clock ts of the last fetch we kicked. 0 = never. */
  lastFetchAt: number;
}

/** Per-session git filesystem watcher. Composed (not extended) by the dispatcher
    so it can be mocked in tests + closed cleanly on app shutdown. */
export class GitWatcher {
  private readonly attached = new Map<string, SessionAttachment>();
  private readonly watch: WatchFn;
  private readonly debounceMs: number;
  private readonly resolve: (worktreePath: string) => string | null;
  private readonly resolveCommon: (gitDir: string) => string;
  private readonly fetch: FetchFn;
  private readonly fetchIntervalMs: number;
  private readonly fetchMinGapMs: number;

  constructor(
    private store: Store,
    private gitService: GitService,
    opts: GitWatcherOptions = {},
  ) {
    this.watch = opts.watch ?? fsWatch;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.resolve = opts.resolveGitDir ?? resolveGitDir;
    this.resolveCommon = opts.resolveCommonDir ?? commonGitDir;
    this.fetch = opts.fetch ?? defaultFetch;
    // Default ON in production; tests pass 0 to skip spawning timers.
    this.fetchIntervalMs = opts.fetchIntervalMs ?? FETCH_INTERVAL_MS;
    this.fetchMinGapMs = opts.fetchMinGapMs ?? FETCH_MIN_GAP_MS;
  }

  /** Idempotent: a second attach with the same branch+base is a no-op. If the
      branch OR base CHANGED (auto-rename, base re-pick) we detach + re-attach
      so the per-branch / per-base ref watchers track the new files. */
  attach(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    if (!session.worktreePath || !existsSync(session.worktreePath)) return;

    const base = session.baseBranch ?? null;
    const branch = session.branch ?? null;

    const existing = this.attached.get(sessionId);
    if (existing) {
      if (existing.worktreePath === session.worktreePath && existing.branch === branch && existing.base === base) return;
      this.detach(sessionId);
    }

    const gitDir = this.resolve(session.worktreePath);
    if (!gitDir) return;
    const commonDir = this.resolveCommon(gitDir);

    const files = trackedFiles(gitDir, branch, base, commonDir);
    const watchers: FSWatcher[] = [];
    const att: SessionAttachment = {
      worktreePath: session.worktreePath, branch, base,
      watchers, timer: null, fetchTimer: null, lastFetchAt: 0,
    };

    for (const f of files) {
      try {
        const w = this.watch(f, () => this.kick(sessionId));
        // Don't take down the dispatcher when a file vanishes / is replaced
        // (git frequently atomic-swaps refs); just stop watching that one.
        w.on?.('error', () => { try { w.close(); } catch { /* ignore */ } });
        watchers.push(w);
      } catch {
        // Missing file is fine — `index` doesn't exist on a brand-new repo,
        // `ORIG_HEAD` only exists after a merge, `refs/remotes/origin/<base>`
        // doesn't exist until the first fetch. The other watchers carry it,
        // and the background fetch below will create the remote ref.
      }
    }

    // Background fetch interval — keeps refs/remotes/origin/<base> fresh so
    // "behind by N" surfaces without the operator hitting Refresh. Skipped
    // when fetchIntervalMs is 0 (tests, no-fetch mode).
    if (this.fetchIntervalMs > 0 && base) {
      att.fetchTimer = setInterval(() => { void this.maybeFetch(sessionId); }, this.fetchIntervalMs);
      // unref so the timer never blocks app shutdown.
      try { att.fetchTimer.unref?.(); } catch { /* ignore */ }
    }

    this.attached.set(sessionId, att);
  }

  /** Idempotent close + delete; safe to call from prune hooks regardless of state. */
  detach(sessionId: string): void {
    const att = this.attached.get(sessionId);
    if (!att) return;
    if (att.timer) clearTimeout(att.timer);
    if (att.fetchTimer) clearInterval(att.fetchTimer);
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

  /** Background fetch — runs from the per-session interval. Quietly skips
      when the last fetch is younger than `fetchMinGapMs` (suppresses storm
      when the user is actively pushing/pulling and our watchers already
      caught the change). The resulting FETCH_HEAD/refs/remotes write is
      picked up by the existing `fs.watch` triggers above, so we don't have
      to call `kick` here explicitly — the file change does it for us. */
  private async maybeFetch(sessionId: string): Promise<void> {
    const att = this.attached.get(sessionId);
    if (!att) return;
    const now = Date.now();
    if (now - att.lastFetchAt < this.fetchMinGapMs) return;
    att.lastFetchAt = now;
    try { await this.fetch(att.worktreePath); } catch { /* best effort */ }
  }

  /** Test seam: manually trigger the background fetch for a session. Returns
      true if the fetch actually ran (false when suppressed by the min-gap
      throttle). Used in tests to verify the gating + the worktree path that
      reaches the fetch implementation. */
  async runFetchNow(sessionId: string): Promise<boolean> {
    const att = this.attached.get(sessionId);
    if (!att) return false;
    const before = att.lastFetchAt;
    await this.maybeFetch(sessionId);
    return att.lastFetchAt !== before;
  }
}
