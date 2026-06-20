/* Pure classification of a failed sync/fetch into a user-actionable kind.
   Kept dependency-free (no react-native imports) so it runs under vitest in
   plain node. Drives whether the phone shows "reconnect/re-pair" vs "offline"
   vs "retry" instead of spinning forever on a stale/disconnected deck. */

import { describe, expect, it } from 'vitest';
import { classifySyncError, type SyncErrorKind } from './syncErrors';

// Mirrors api.ts's ApiError (status + message) without importing it (that pulls
// the whole react-native api module). classifySyncError only reads `.status`.
const apiErr = (status: number): { status: number; message: string } => ({ status, message: `e${status}` });

describe('classifySyncError', () => {
  it('maps 401 (token rejected / deck evicted) to "unauthorized" → re-pair', () => {
    expect(classifySyncError(apiErr(401))).toBe('unauthorized');
  });

  it('maps 403 to "unauthorized"', () => {
    expect(classifySyncError(apiErr(403))).toBe('unauthorized');
  });

  it('maps 503 (no Mac paired / Mac offline) to "offline"', () => {
    expect(classifySyncError(apiErr(503))).toBe('offline');
  });

  it('maps 502/504 (relay can\'t reach the Mac) to "offline"', () => {
    expect(classifySyncError(apiErr(502))).toBe('offline');
    expect(classifySyncError(apiErr(504))).toBe('offline');
  });

  it('maps a raw network failure (no status, e.g. fetch TypeError) to "network"', () => {
    expect(classifySyncError(new TypeError('Network request failed'))).toBe('network');
    expect(classifySyncError(undefined)).toBe('network');
  });

  it('maps an unexpected 500 to "network" (transient/retryable, not a pairing problem)', () => {
    expect(classifySyncError(apiErr(500))).toBe('network');
  });
});
