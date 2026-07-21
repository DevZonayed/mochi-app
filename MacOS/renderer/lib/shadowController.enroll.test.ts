/**
 * shadowController.enroll.test.ts — Phase 3C2 (F1) view-model unit tests for the
 * enrollment-session mapper. `mapEnrollmentSession` surfaces ONLY the phrase + expiry
 * to the operator, retains the sessionId (for cancel, never rendered), and keeps the
 * signed `qr` for the LOCAL QR renderer only. No host fingerprint / grant / key id is
 * exposed as a display field.
 */
import { describe, it, expect } from 'vitest';
import { mapEnrollmentSession, type CreateSessionWire } from './shadowController';

const wire: CreateSessionWire = {
  sessionId: 'sess-1',
  qr: 'maestro-shadow://enroll?sid=sess-1&sec=SECRET',
  expiresAt: 1_800_000,
  hostFingerprint: 'FP-INTERNAL',
  hostAuthString: 'zebra-mint-7',
};

describe('mapEnrollmentSession (F1)', () => {
  it('maps phrase + expiry + qr + sessionId; drops the host fingerprint', () => {
    const v = mapEnrollmentSession(wire);
    expect(v.verificationPhrase).toBe('zebra-mint-7');
    expect(v.expiresAt).toBe(1_800_000);
    expect(v.qr).toBe(wire.qr);          // qr retained for the local QR renderer only
    expect(v.sessionId).toBe('sess-1');  // retained to cancel, never rendered
    // No fingerprint / grant / key field on the view.
    expect(Object.keys(v).sort()).toEqual(['expiresAt', 'qr', 'sessionId', 'verificationPhrase']);
    expect(JSON.stringify(v)).not.toContain('FP-INTERNAL');
  });
});
