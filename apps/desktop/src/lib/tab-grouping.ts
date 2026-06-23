/* tab-grouping — pure helpers backing the Workspace tab strip (Track 6).
 *
 * The actual rendering lives in Workspace.tsx; this module isolates the
 * decisions ("which projects own which tabs?") so they can be exercised with
 * plain unit tests, without spinning up a full renderer environment. Keep
 * this file free of React imports.
 */

export interface TabLike {
  /** Unique tab key. */
  key: string;
  /** Owning project. The tab strip groups tabs that share this id. */
  projectId: string;
}

export interface TabGroup<T extends TabLike> {
  projectId: string;
  tabs: T[];
}

/**
 * Group tabs by `projectId`, preserving the order in which each project
 * first appeared. Within a group, tabs keep their input order.
 *
 * Equivalent to `Object.groupBy(tabs, t => t.projectId)` but ES2022-safe
 * and order-stable (Object.groupBy returns a plain object whose key order
 * is not guaranteed for numeric-looking keys).
 */
export function groupTabsByProject<T extends TabLike>(tabs: readonly T[]): TabGroup<T>[] {
  const order: string[] = [];
  const buckets: Record<string, T[]> = {};
  for (const t of tabs) {
    if (!buckets[t.projectId]) { buckets[t.projectId] = []; order.push(t.projectId); }
    buckets[t.projectId].push(t);
  }
  return order.map(pid => ({ projectId: pid, tabs: buckets[pid] }));
}

export interface ExpansionState {
  /** The currently active project (derived from the active tab's projectId). */
  activeProjectId: string | null;
  /** Projects the user has pinned open. */
  pinnedGroups: ReadonlySet<string>;
  /** A non-pinned project the user clicked open ("peek"). At most one. */
  peekGroup: string | null;
  /** How many groups exist right now. With ≤1 we never collapse. */
  groupCount: number;
}

/** Decide whether a project's tab group renders full-width or collapsed-to-avatar. */
export function isGroupExpanded(projectId: string, s: ExpansionState): boolean {
  if (s.groupCount <= 1) return true;
  if (projectId === s.activeProjectId) return true;
  if (s.pinnedGroups.has(projectId)) return true;
  if (s.peekGroup === projectId) return true;
  return false;
}

/** Drop pin ids whose project no longer has any open tab. Pure. */
export function prunePinnedGroups<T extends TabLike>(pinned: ReadonlySet<string>, groups: readonly TabGroup<T>[]): Set<string> {
  const live = new Set(groups.map(g => g.projectId));
  const next = new Set<string>();
  for (const id of pinned) if (live.has(id)) next.add(id);
  return next;
}
