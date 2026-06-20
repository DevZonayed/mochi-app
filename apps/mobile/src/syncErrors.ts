/* How a failed /api/sync (or any relay fetch) should read to the user.

   Dependency-free on purpose: no react-native / api imports, so the sync store
   and screens can classify an error into an actionable state without pulling the
   native module graph (and so it's unit-testable in plain node).

   - 'unauthorized' — the relay rejected our pairing token (kicked, code rotated,
     or our deck was evicted after going offline). The phone must RE-PAIR.
   - 'offline'      — relay reachable but no live Mac for our token (503), or the
     relay couldn't reach the Mac (502/504). Show "Mac offline", offer retry.
   - 'network'      — couldn't reach the relay at all (no HTTP status), or an
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
