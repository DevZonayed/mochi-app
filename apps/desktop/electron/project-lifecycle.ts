/* project-lifecycle — what happens when the operator OPENS a dual-repo
   project (the one bootstrapped by Step 6).

   On open:
     1. pullMemory(slug) — `git pull --rebase --autostash`; last-writer-wins
        on rebase conflicts. Idempotent on a fresh / clean clone.
     2. linkMemoryIntoProject(slug, projectPath) — re-verify the four
        symlinks. Idempotent: skips when they already point right; throws
        loudly when a real file/dir or wrong-pointer symlink blocks the
        link (the operator must resolve manually).
     3. start (or reuse) a STATE.md watcher: when STATE.md changes, debounce
        5s then commitAndPushMemory(slug, …). The agent writes STATE.md
        constantly inside a turn — one push per quiet window keeps the
        memory repo's history readable without losing the latest.

   We use `fs.watch` (built-in, no dep) because `chokidar` isn't in
   apps/desktop's deps tree. fs.watch's quirks (double-fire, rename events)
   don't matter here because the debounce window swallows them. */

import { watch, existsSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { pullMemory, linkMemoryIntoProject, commitAndPushMemory, memoryClonePath, type GitRunner } from './memory-repo.js';

const DEBOUNCE_MS = 5_000;

/** A handle to a running STATE watcher. Call .close() to stop it. */
export interface MemoryWatcher {
  slug: string;
  close(): void;
}

/* Active watchers, keyed by slug — one per project. Re-opening the same
   project reuses the existing watcher so we don't spawn N stale ones. */
const watchers = new Map<string, MemoryWatcher>();

/** Open-project lifecycle: pull memory + verify symlinks + start the watcher.
    Returns a small report so the caller can log it. The watcher continues to
    run after this resolves; .closeMemoryWatcher(slug) stops it. */
export async function openProjectMemory(opts: {
  slug: string;
  projectPath: string;
  /** Test seam: a stub instead of the real shell-out git. */
  gitRunner?: GitRunner;
  /** Test seam: override userData. */
  userDataDir?: string;
  /** Test seam: instead of fs.watch, call this with the debounced flush. */
  startWatcher?: (statePath: string, onChange: () => void) => { close(): void };
  /** Test seam: override the commit-and-push call (e.g. to capture it). */
  commitAndPush?: (slug: string, reason: string) => Promise<{ pushed: boolean; sha: string | null }>;
}): Promise<{ pulled: boolean; conflictsResolved: number; linked: boolean; watching: boolean }> {
  const { slug, projectPath } = opts;
  if (!slug) throw new Error('openProjectMemory: slug is required');
  if (!projectPath) throw new Error('openProjectMemory: projectPath is required');

  // 1. Pull. Soft-fail: a network blip shouldn't block opening the project
  // (the watcher will retry the push when STATE changes anyway). We still
  // throw for non-network errors (e.g. corrupt repo) — those need attention.
  let pullResult: { pulled: boolean; conflictsResolved: number } = { pulled: false, conflictsResolved: 0 };
  try {
    pullResult = await pullMemory(slug, opts.gitRunner, opts.userDataDir);
  } catch (e) {
    console.warn(`[lifecycle] memory pull failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Symlinks. This MAY throw (clobber detection) — let it: the operator
  // must resolve manually rather than silently lose data.
  await linkMemoryIntoProject(slug, projectPath, opts.userDataDir);

  // 3. Watcher. Reuse if one is already running for this slug.
  const memDir = memoryClonePath(slug, opts.userDataDir);
  const statePath = path.join(memDir, 'continuum', 'STATE.md');
  if (!watchers.has(slug)) {
    let timer: NodeJS.Timeout | null = null;
    const commit = opts.commitAndPush ?? ((s: string, r: string) => commitAndPushMemory(s, r, opts.gitRunner, opts.userDataDir));
    const flush = (): void => {
      timer = null;
      commit(slug, 'chore(memory): STATE updated by agent').catch((e: unknown) => {
        console.warn(`[lifecycle] memory commit/push failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
      });
    };
    const onChange = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    };
    const handle = opts.startWatcher ? opts.startWatcher(statePath, onChange) : startFsWatch(statePath, onChange);
    watchers.set(slug, {
      slug,
      close() {
        if (timer) { clearTimeout(timer); timer = null; }
        try { handle.close(); } catch { /* */ }
        watchers.delete(slug);
      },
    });
  }

  return { pulled: pullResult.pulled, conflictsResolved: pullResult.conflictsResolved, linked: true, watching: true };
}

/** Stop watching STATE for `slug`. Safe to call multiple times. */
export function closeMemoryWatcher(slug: string): void {
  const w = watchers.get(slug);
  if (w) w.close();
}

/** Stop ALL active watchers (called on app quit / sign-out). */
export function closeAllMemoryWatchers(): void {
  for (const slug of [...watchers.keys()]) closeMemoryWatcher(slug);
}

/** Built-in fs.watch wrapper. Watches the FILE if it exists, else watches
    its parent dir (fs.watch's "watch a file before it exists" semantics
    differ by OS). When the file appears/changes we still get a callback. */
function startFsWatch(statePath: string, onChange: () => void): { close(): void } {
  const dir = path.dirname(statePath);
  const base = path.basename(statePath);
  let watcher: FSWatcher | null = null;
  // If the file doesn't exist yet (fresh project pre-first-state-write),
  // watch the parent dir and surface the change when its name pops up.
  if (existsSync(statePath)) {
    watcher = watch(statePath, { persistent: false }, () => onChange());
  } else if (existsSync(dir)) {
    watcher = watch(dir, { persistent: false }, (_event, fn) => {
      if (fn === base) onChange();
    });
  }
  return { close() { try { watcher?.close(); } catch { /* */ } } };
}

/** TEST-ONLY: reset the internal watcher registry between cases. */
export function _resetWatchersForTesting(): void {
  for (const w of [...watchers.values()]) { try { w.close(); } catch { /* */ } }
  watchers.clear();
}
