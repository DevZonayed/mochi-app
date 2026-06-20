/* How a failed /api/sync (or any server fetch) should read to the user.

   Dependency-free on purpose: no react-native / api imports, so the sync store
   and screens can classify an error into an actionable state without pulling the
   native module graph (and so it's unit-testable in plain node).

   - 'unauthorized' — the server rejected our account session (expired / signed
     out elsewhere). The phone must SIGN IN again.
   - 'offline'      — server reachable but the active Mac is offline (503) or
     didn't respond (502/504), or no host is selected yet. Offer retry.
   - 'network'      — couldn't reach the server at all (no HTTP status), or an
     unexpected 5xx. Transient; offer retry. */

export type SyncErrorKind = 'offline' | 'unauthorized' | 'network';

/** Pull an HTTP status off an unknown thrown value (ApiError carries `.status`). */
function statusOf(err: unknown): number {
  const s = (err as { status?: unknown } | null | undefined)?.status;
  return typeof s === 'number' ? s : 0;
}

export function classifySyncError(err: unknown): SyncErrorKind {
  const status = statusOf(err);
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 503 || status === 502 || status === 504) return 'offline';
  return 'network';
}
