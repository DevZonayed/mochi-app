/* Per-session port isolation. Pure (no Electron/fs) so it unit-tests freely.

   Conductor hands every workspace a block of 10 ports (CONDUCTOR_PORT … +9); we
   mirror that idea. Each session owns a stable, contiguous block of PORT_SPAN
   ports derived deterministically from (projectId, sessionId), then linear-probed
   away from blocks already in use so two LIVE sessions of the same project never
   collide on a dev-server port. The block is exposed to the session's processes
   (and its setup script) as the MOCHI_* env contract below. */

/** Block of ports this app hands to sessions — high, unprivileged, unlikely to
    clash with common dev defaults (3000/5173/8080 still sit below this). */
export const PORT_RANGE_START = 41000;
export const PORT_RANGE_END = 52000; // exclusive
export const PORT_SPAN = 10; // ports per session block (MOCHI_PORT … +9)
export const PORT_BUCKETS = Math.floor((PORT_RANGE_END - PORT_RANGE_START) / PORT_SPAN);

/** Deterministic 32-bit FNV-1a hash. Stable across runs and processes (so a
    session keeps the same preferred block on every launch). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Preferred block base for a session — stable, but may collide with another
    session that happens to hash into the same bucket. */
export function preferredPortBase(projectId: string, sessionId: string): number {
  const bucket = hashString(`${projectId}/${sessionId}`) % PORT_BUCKETS;
  return PORT_RANGE_START + bucket * PORT_SPAN;
}

/** Allocate a free block base: start at the preferred bucket and linear-probe by
    one block at a time (wrapping within the range), skipping any base in `taken`.
    Falls back to the preferred base only if every block is occupied — which needs
    >PORT_BUCKETS concurrent sessions and never happens in practice. */
export function allocatePortBase(projectId: string, sessionId: string, taken: ReadonlySet<number>): number {
  const startBucket = (preferredPortBase(projectId, sessionId) - PORT_RANGE_START) / PORT_SPAN;
  for (let i = 0; i < PORT_BUCKETS; i++) {
    const base = PORT_RANGE_START + ((startBucket + i) % PORT_BUCKETS) * PORT_SPAN;
    if (!taken.has(base)) return base;
  }
  return preferredPortBase(projectId, sessionId);
}

/** The MOCHI_* environment a session's processes (and setup script) receive.
    Mirrors Conductor's CONDUCTOR_* contract so projects can configure dev servers
    against a known port and locate their workspace. */
export function sessionPortEnv(opts: {
  portBase: number;
  workspacePath: string;
  projectId: string | null;
  sessionId: string | null;
  defaultBranch?: string | null;
  isLocal?: boolean;
}): Record<string, string> {
  return {
    MOCHI_PORT: String(opts.portBase),
    MOCHI_PORT_RANGE: `${opts.portBase}-${opts.portBase + PORT_SPAN - 1}`,
    MOCHI_WORKSPACE_PATH: opts.workspacePath,
    MOCHI_PROJECT_ID: opts.projectId ?? '',
    MOCHI_SESSION_ID: opts.sessionId ?? '',
    MOCHI_DEFAULT_BRANCH: opts.defaultBranch ?? '',
    MOCHI_IS_LOCAL: opts.isLocal === false ? '0' : '1',
  };
}
