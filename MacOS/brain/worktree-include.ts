/* Resolve which gitignored files get copied into a fresh session worktree. Pure
   (no fs) so it unit-tests freely — the caller reads `.worktreeinclude` and hands
   the text in.

   Resolution order mirrors Conductor's Files-to-copy:
     1. `.worktreeinclude` at the repo root (committed, shared with teammates):
        newline-separated globs, `#` comments and blank lines ignored.
     2. The project's configured `copyGlobs` (per-machine app setting).
     3. Default `['.env*']`. */

export const DEFAULT_COPY_GLOBS = ['.env*'];

/** Parse `.worktreeinclude` text into glob lines (drops comments + blanks). */
export function parseWorktreeInclude(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Pick the effective copy globs for a worktree given the (optional) committed
    `.worktreeinclude` text and the project's configured globs. */
export function resolveCopyGlobs(opts: {
  worktreeIncludeText?: string | null;
  projectGlobs?: string[] | null;
}): string[] {
  if (opts.worktreeIncludeText != null) {
    const fromFile = parseWorktreeInclude(opts.worktreeIncludeText);
    if (fromFile.length) return fromFile;
  }
  if (opts.projectGlobs && opts.projectGlobs.length) return opts.projectGlobs;
  return [...DEFAULT_COPY_GLOBS];
}
