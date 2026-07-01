/* Per-project Playwright profile locations. ONE source of truth for where a
   project's persistent Chrome profile lives, so the manager, the "clear data"
   action, and "reveal in Finder" all agree. `userDataDir` already carries the
   app identity (~/Library/Application Support/@maestro/desktop), so we never
   hardcode the app name a second time here. */
import path from 'node:path';

// Drop EVERYTHING outside [a-z0-9_-] — note `.` is excluded on purpose so a
// projectId of '..' can never resolve to the parent dir via path.join.
const UNSAFE = /[^a-zA-Z0-9_-]/g;

/** Root that holds every project's profile dir. */
export function browserProfilesRoot(userDataDir: string): string {
  return path.join(userDataDir, 'browser-profiles');
}

/** A single project's persistent Chrome `--user-data-dir`. Project id is
    sanitized to a safe single path segment (no traversal, no separators). */
export function browserProfileDir(userDataDir: string, projectId: string): string {
  const safe = projectId.replace(UNSAFE, '_');
  return path.join(browserProfilesRoot(userDataDir), safe);
}
