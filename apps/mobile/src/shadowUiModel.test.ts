/**
 * shadowUiModel.test.ts — Phase 3C2 pure view-model contract. Proves the enrollment
 * state machine → UI phase mapping, the zero-stale content gate, safe-only field
 * mapping/omission, and the negative security contract (no crypto/raw/fabricated data).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveShadowUiState, deriveShadowUiPhase, projectionVisible, isLockedPhase, isRetryablePhase,
  shortId, capabilityLabel, genericEnrollmentError,
  type ShadowUiInputs, type ShadowUiPhase,
} from './shadowUiModel';
import type { EnrollmentStatus, EnrollmentState } from './shadowEnrollmentClient';
import type { ControllerServiceStatus } from './shadowControllerService';

const NOW = 1_000_000;

function enr(state: EnrollmentState, over: Partial<EnrollmentStatus> = {}): EnrollmentStatus {
  return {
    state, accountId: 'acct_1', controllerDeviceId: 'ctrl_device_abcdef012345678', hostFingerprint: 'hostkey_fingerprint_zzz999',
    requestedCapabilities: ['account.read'],
    scopeKeyId: state === 'online' ? 'sk_1' : null, online: state === 'online', ...over,
  };
}
function svc(over: Partial<ControllerServiceStatus> = {}): ControllerServiceStatus {
  return { state: 'offline', online: false, lastSeq: 3, entities: 2, locked: false, leaseExpiresAt: NOW + 60_000, ...over };
}
function inputs(over: Partial<ShadowUiInputs> = {}): ShadowUiInputs {
  return { authed: true, purgePending: false, enrollment: null, service: null, lastActivityAt: null, now: NOW, ...over };
}

describe('deriveShadowUiPhase — enrollment state machine → UI phase', () => {
  const cases: Array<[EnrollmentState, ShadowUiPhase]> = [
    ['idle', 'unenrolled'], ['cancelled', 'unenrolled'], ['error', 'unenrolled'],
    ['parsing', 'confirming'], ['confirming', 'confirming'],
    ['requesting', 'requesting'], ['awaiting-host', 'pending'], ['accepted', 'approving'],
    ['denied', 'denied'], ['expired', 'expired'], ['revoked', 'revoked'], ['locked', 'repair'],
  ];
  for (const [state, phase] of cases) {
    it(`${state} → ${phase}`, () => {
      expect(deriveShadowUiPhase(inputs({ enrollment: enr(state) }))).toBe(phase);
    });
  }

  it('unauthenticated → unenrolled (never content)', () => {
    expect(deriveShadowUiPhase(inputs({ authed: false, enrollment: enr('online'), service: svc({ online: true }) }))).toBe('unenrolled');
  });
  it('purge pending → loading (fail closed, no content)', () => {
    expect(deriveShadowUiPhase(inputs({ purgePending: true, enrollment: enr('online'), service: svc({ online: true }) }))).toBe('loading');
  });
  it('no runtime yet → loading', () => {
    expect(deriveShadowUiPhase(inputs({ enrollment: null }))).toBe('loading');
  });
  it('online grant + connected service → online', () => {
    expect(deriveShadowUiPhase(inputs({ enrollment: enr('online'), service: svc({ online: true, state: 'online' }) }))).toBe('online');
  });
  it('online grant + offline service → offline', () => {
    expect(deriveShadowUiPhase(inputs({ enrollment: enr('online'), service: svc({ online: false }) }))).toBe('offline');
  });
  it('online grant + restored, no service built yet → offline (last verified)', () => {
    expect(deriveShadowUiPhase(inputs({ enrollment: enr('online'), service: null }))).toBe('offline');
  });
  it('locked SERVICE (host revoke / 401) beats a cached online grant → revoked', () => {
    expect(deriveShadowUiPhase(inputs({ enrollment: enr('online'), service: svc({ online: true, state: 'online', locked: true }) }))).toBe('revoked');
  });
  it('live grant + missing local authority → repair', () => {
    expect(deriveShadowUiPhase(inputs({ enrollment: enr('online'), service: null, localAuthorityMissing: true }))).toBe('repair');
  });
  it('lapsed renewable lease is truthful OFFLINE (not a terminal), auto-reconcile renews', () => {
    // online grant, service offline, lease already past → offline read-only, never online.
    expect(deriveShadowUiPhase(inputs({ enrollment: enr('online'), service: svc({ online: false, leaseExpiresAt: NOW - 10_000 }) }))).toBe('offline');
  });
});

describe('content gate (zero stale flash)', () => {
  it('content is visible ONLY in online/offline', () => {
    const visible: ShadowUiPhase[] = ['online', 'offline'];
    const hidden: ShadowUiPhase[] = ['loading', 'unenrolled', 'confirming', 'requesting', 'pending', 'approving', 'denied', 'expired', 'revoked', 'repair'];
    for (const p of visible) expect(projectionVisible(p)).toBe(true);
    for (const p of hidden) expect(projectionVisible(p)).toBe(false);
  });
  it('a revoked service never marks content visible even with a live online grant', () => {
    const st = deriveShadowUiState(inputs({ enrollment: enr('online'), service: svc({ online: true, state: 'online', locked: true }) }));
    expect(st.phase).toBe('revoked');
    expect(st.contentVisible).toBe(false);
    expect(st.locked).toBe(true);
  });
});

describe('safe-only field mapping + no fabrication', () => {
  it('maps short ids + canonical staged capability labels', () => {
    const st = deriveShadowUiState(inputs({ enrollment: enr('awaiting-host') }));
    expect(st.enrollment.controllerDeviceIdShort).toBe(shortId('ctrl_device_abcdef012345678'));
    expect(st.enrollment.controllerDeviceLabel).toBe(shortId('ctrl_device_abcdef012345678'));
    expect(st.enrollment.hostFingerprintShort).toBe(shortId('hostkey_fingerprint_zzz999'));
    expect(st.enrollment.requestedCapabilityLabels).toEqual([capabilityLabel('account.read')]);
    expect(st.enrollment.requestedCapabilityLabels).toEqual(['Read your projects & activity']);
  });
  it('renders the full staged set in canonical order', () => {
    const st = deriveShadowUiState(inputs({
      enrollment: enr('confirming', {
        requestedCapabilities: ['screen.view', 'job.cancel', 'account.read', 'job.start', 'session.message', 'question.answer', 'approval.respond', 'session.autopilot.set'],
      }),
    }));
    expect(st.enrollment.requestedCapabilityLabels).toEqual([
      'Read your projects & activity',
      'Send messages in a session',
      'Start jobs',
      'Cancel jobs',
      'Respond to approvals',
      'Answer questions',
      'Change session autopilot',
      'View your Mac screen (view only · no audio)',
    ]);
  });
  it('uses bounded device copy before identity generation', () => {
    const st = deriveShadowUiState(inputs({ enrollment: enr('confirming', { controllerDeviceId: null }) }));
    expect(st.enrollment.controllerDeviceIdShort).toBeNull();
    expect(st.enrollment.controllerDeviceLabel).toBe('Created when requested');
  });
  it('lastActivityAt is omitted (null) when unknown — never now/0', () => {
    expect(deriveShadowUiState(inputs({ enrollment: enr('online'), service: svc() })).connection.lastActivityAt).toBeNull();
    expect(deriveShadowUiState(inputs({ enrollment: enr('online'), service: svc(), lastActivityAt: 0 })).connection.lastActivityAt).toBeNull();
    expect(deriveShadowUiState(inputs({ enrollment: enr('online'), service: svc(), lastActivityAt: NOW - 5000 })).connection.lastActivityAt).toBe(NOW - 5000);
  });
  it('no fake percent/count/timer fields exist on the state', () => {
    const st = deriveShadowUiState(inputs({ enrollment: enr('awaiting-host') }));
    const json = JSON.stringify(st);
    expect(json).not.toMatch(/percent|progress|eta|"timer"|countdown/i);
  });
});

describe('negative security contract — no secrets ever surface', () => {
  it('error reasons are generic; raw runtime diagnostics never pass through', () => {
    const raw = 'connect ECONNREFUSED /Users/alice/.aws/credentials sk-ant-secret at load (';
    const st = deriveShadowUiState(inputs({ enrollment: enr('error', { lastError: raw }) }));
    expect(st.enrollment.errorReason).toBe('Something went wrong. Please try again.');
    expect(JSON.stringify(st)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(st)).not.toContain('sk-ant');
    expect(JSON.stringify(st)).not.toContain('/Users/');
  });
  it('terminal reasons map to bounded product copy', () => {
    expect(genericEnrollmentError('anything', 'denied')).toBe('This Mac declined the request.');
    expect(genericEnrollmentError('anything', 'expired')).toBe('The enrollment window expired before it was approved.');
    expect(genericEnrollmentError('anything', 'revoked')).toBe('Access was revoked from your Mac.');
    expect(genericEnrollmentError('anything', 'repair')).toBe('This device’s saved access is no longer valid.');
    expect(genericEnrollmentError(undefined, 'online')).toBeNull();
  });
  it('renders allowlisted enrollment status/category errors but not raw diagnostics', () => {
    expect(genericEnrollmentError('Enrollment request rejected (401): sign in again', 'unenrolled')).toBe('Enrollment request rejected (401): sign in again');
    expect(genericEnrollmentError('Enrollment request rejected (400): invalid device identity', 'unenrolled')).toBe('Enrollment request rejected (400): invalid device identity');
    expect(genericEnrollmentError('Network request failed', 'unenrolled')).toBe('Network request failed');
    expect(genericEnrollmentError('Enrollment request rejected (401): Bearer sk-secret', 'unenrolled')).toBe('Something went wrong. Please try again.');
  });
  it('the enrollment display exposes no crypto/nonce/transcript/scopeKey fields', () => {
    const st = deriveShadowUiState(inputs({ enrollment: enr('online', { scopeKeyId: 'sk_secret' }) }));
    const keys = Object.keys(st.enrollment);
    for (const forbidden of ['scopeKey', 'nonce', 'transcript', 'privateKey', 'secret', 'signature']) {
      expect(keys.some((k) => k.toLowerCase().includes(forbidden.toLowerCase()))).toBe(false);
    }
  });
});

describe('phase classification helpers', () => {
  it('locked phases require re-enrollment', () => {
    expect(isLockedPhase('revoked')).toBe(true);
    expect(isLockedPhase('repair')).toBe(true);
    expect(isLockedPhase('offline')).toBe(false);
  });
  it('denied/expired are retryable', () => {
    expect(isRetryablePhase('denied')).toBe(true);
    expect(isRetryablePhase('expired')).toBe(true);
    expect(isRetryablePhase('revoked')).toBe(false);
  });
  it('shortId truncates only long ids, passes short ones, null-safe', () => {
    expect(shortId(null)).toBeNull();
    expect(shortId('short')).toBe('short');
    expect(shortId('a'.repeat(40))).toContain('…');
  });
});
