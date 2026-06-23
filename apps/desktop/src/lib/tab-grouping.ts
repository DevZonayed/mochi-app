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
