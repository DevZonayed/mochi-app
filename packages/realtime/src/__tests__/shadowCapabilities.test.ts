import { describe, expect, it } from 'vitest';
import {
  SHADOW_CAPABILITIES,
  SHADOW_CAPABILITY_VERSION,
  SHADOW_DEFAULT_CAPABILITIES,
  SHADOW_MAX_CAPABILITIES,
  SHADOW_MAX_CAPABILITY_STRING_LEN,
  SHADOW_ACTION_CAPABILITIES,
  SHADOW_SCREEN_VIEW_CAPABILITY,
  canonicalizeCapabilities,
  capabilitiesCanonicalString,
  hasCapability,
  intersectApprovedCapabilities,
  isKnownCapability,
  isScreenViewCapability,
  screenViewPermittedBy,
  methodPermittedBy,
  requiredCapabilityForMethod,
  CONTROLLER_METHOD_CAPABILITY,
  type ShadowCapability,
} from '../shadowCapabilities';

describe('shadowCapabilities — canonical vocabulary', () => {
  it('exposes the versioned canonical vocabulary and default floor', () => {
    expect(SHADOW_CAPABILITY_VERSION).toBe(1);
    expect(SHADOW_CAPABILITIES).toEqual([
      'account.read',
      'session.message',
      'job.start',
      'job.cancel',
      'approval.respond',
      'question.answer',
      'session.autopilot.set',
      'screen.view',
    ]);
    expect(SHADOW_DEFAULT_CAPABILITIES).toEqual(['account.read']);
    expect(SHADOW_MAX_CAPABILITIES).toBe(SHADOW_CAPABILITIES.length);
  });

  it('isKnownCapability recognises exactly the vocabulary', () => {
    for (const cap of SHADOW_CAPABILITIES) expect(isKnownCapability(cap)).toBe(true);
    expect(isKnownCapability('account.write')).toBe(false);
    expect(isKnownCapability('')).toBe(false);
    expect(isKnownCapability(42)).toBe(false);
    expect(isKnownCapability(null)).toBe(false);
    expect(isKnownCapability(undefined)).toBe(false);
  });
});

describe('shadowCapabilities — canonicalize', () => {
  it('defaults undefined/null/empty to account.read', () => {
    for (const input of [undefined, null, []]) {
      const r = canonicalizeCapabilities(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.capabilities).toEqual(['account.read']);
    }
  });

  it('rejects empty when allowEmptyDefault=false', () => {
    expect(canonicalizeCapabilities(undefined, { allowEmptyDefault: false })).toEqual({ ok: false, reason: 'empty' });
    expect(canonicalizeCapabilities([], { allowEmptyDefault: false })).toEqual({ ok: false, reason: 'empty' });
  });

  it('dedupes and sorts into canonical vocabulary order regardless of input order', () => {
    const a = canonicalizeCapabilities(['job.start', 'account.read', 'job.start']);
    const b = canonicalizeCapabilities(['account.read', 'job.start']);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.capabilities).toEqual(['account.read', 'job.start']);
      expect(a.capabilities).toEqual(b.capabilities);
    }
  });

  it('is order-independent for the full set (canonical is deterministic)', () => {
    const forward = canonicalizeCapabilities([...SHADOW_CAPABILITIES]);
    const reversed = canonicalizeCapabilities([...SHADOW_CAPABILITIES].reverse());
    expect(forward.ok && reversed.ok).toBe(true);
    if (forward.ok && reversed.ok) {
      expect(forward.capabilities).toEqual([...SHADOW_CAPABILITIES]);
      expect(forward.capabilities).toEqual(reversed.capabilities);
    }
  });

  it('rejects unknown / non-string / over-length / oversized-count (fail closed)', () => {
    expect(canonicalizeCapabilities(['account.read', 'account.delete'])).toMatchObject({ ok: false });
    expect(canonicalizeCapabilities(['account.read', 123 as unknown as string])).toEqual({ ok: false, reason: 'non-string' });
    expect(canonicalizeCapabilities('account.read' as unknown)).toEqual({ ok: false, reason: 'not-array' });
    const longTok = 'a'.repeat(SHADOW_MAX_CAPABILITY_STRING_LEN + 1);
    expect(canonicalizeCapabilities([longTok])).toEqual({ ok: false, reason: 'bad-length' });
    // count bound: more elements than the whole vocabulary
    const tooMany = [...SHADOW_CAPABILITIES, 'account.read'];
    expect(canonicalizeCapabilities(tooMany)).toEqual({ ok: false, reason: 'too-many' });
    // an unknown reason string is bounded in length
    const r = canonicalizeCapabilities(['x'.repeat(SHADOW_MAX_CAPABILITY_STRING_LEN)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeLessThanOrEqual(SHADOW_MAX_CAPABILITY_STRING_LEN + 'unknown:'.length);
  });
});

describe('shadowCapabilities — host approval / least privilege', () => {
  it('intersection never widens beyond what was requested', () => {
    const r = intersectApprovedCapabilities(['session.message', 'job.start'], ['session.message', 'job.start', 'job.cancel']);
    expect(r.ok).toBe(true);
    // job.cancel was NOT requested → dropped; account.read floor always kept
    if (r.ok) expect(r.capabilities).toEqual(['account.read', 'session.message', 'job.start']);
  });

  it('host can narrow the requested set', () => {
    const r = intersectApprovedCapabilities(['session.message', 'job.start', 'job.cancel'], ['session.message']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.capabilities).toEqual(['account.read', 'session.message']);
  });

  it('always retains account.read floor even if neither side lists it', () => {
    const r = intersectApprovedCapabilities(['job.start'], ['job.start']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.capabilities).toEqual(['account.read', 'job.start']);
  });

  it('controller cannot self-grant: requesting nothing yields read-only even if host offers more', () => {
    const r = intersectApprovedCapabilities([], ['job.start', 'session.message']);
    expect(r.ok).toBe(true);
    // requested canonicalised to [account.read]; nothing else is a subset → only read
    if (r.ok) expect(r.capabilities).toEqual(['account.read']);
  });

  it('propagates malformed inputs as errors', () => {
    expect(intersectApprovedCapabilities(['bogus'], ['job.start'])).toMatchObject({ ok: false });
    expect(intersectApprovedCapabilities(['job.start'], ['bogus'])).toMatchObject({ ok: false });
  });
});

describe('shadowCapabilities — canonical string + accessors', () => {
  it('canonical string is versioned and stable', () => {
    const r = canonicalizeCapabilities(['job.start', 'account.read']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(capabilitiesCanonicalString(r.capabilities)).toBe('capv1:account.read,job.start');
  });

  it('hasCapability reflects membership', () => {
    const caps: ShadowCapability[] = ['account.read', 'job.start'];
    expect(hasCapability(caps, 'job.start')).toBe(true);
    expect(hasCapability(caps, 'job.cancel')).toBe(false);
  });
});

describe('shadowCapabilities — method → capability mapping', () => {
  it('maps every controller action to a known capability', () => {
    for (const [method, cap] of Object.entries(CONTROLLER_METHOD_CAPABILITY)) {
      expect(isKnownCapability(cap)).toBe(true);
      expect(requiredCapabilityForMethod(method)).toBe(cap);
    }
  });

  it('unknown methods require null → never permitted', () => {
    expect(requiredCapabilityForMethod('controller.shell.exec')).toBeNull();
    expect(requiredCapabilityForMethod('anything')).toBeNull();
    expect(methodPermittedBy('controller.shell.exec', [...SHADOW_CAPABILITIES])).toBe(false);
  });

  it('methodPermittedBy enforces the required capability', () => {
    expect(methodPermittedBy('controller.job.start', ['account.read'])).toBe(false);
    expect(methodPermittedBy('controller.job.start', ['account.read', 'job.start'])).toBe(true);
    expect(methodPermittedBy('controller.account.list', ['account.read'])).toBe(true);
  });
});

describe('shadowCapabilities — screen.view (Phase 3D1, non-action grant capability)', () => {
  it('vocabulary = account.read floor + exactly the six action families + screen.view', () => {
    expect(SHADOW_CAPABILITIES).toContain('account.read');
    expect(SHADOW_CAPABILITIES).toContain('screen.view');
    for (const a of SHADOW_ACTION_CAPABILITIES) expect(SHADOW_CAPABILITIES).toContain(a);
    // the whole vocabulary is exactly floor(1) + actions(6) + screen.view(1) = 8, no more
    expect(SHADOW_CAPABILITIES.length).toBe(1 + SHADOW_ACTION_CAPABILITIES.length + 1);
    expect(SHADOW_ACTION_CAPABILITIES).toEqual([
      'session.message',
      'job.start',
      'job.cancel',
      'approval.respond',
      'question.answer',
      'session.autopilot.set',
    ]);
    // screen.view is NOT one of the action families nor the read floor
    expect(SHADOW_ACTION_CAPABILITIES).not.toContain('screen.view');
    expect(SHADOW_ACTION_CAPABILITIES).not.toContain('account.read');
    expect(isScreenViewCapability(SHADOW_SCREEN_VIEW_CAPABILITY)).toBe(true);
    expect(isScreenViewCapability('job.start')).toBe(false);
  });

  it('the durable action map remains EXACTLY the six mutating actions + two read methods — screen.view is never a method target', () => {
    // No method maps to screen.view, so it can never be dispatched as a durable action.
    for (const cap of Object.values(CONTROLLER_METHOD_CAPABILITY)) {
      expect(cap).not.toBe('screen.view');
    }
    const mutating = Object.entries(CONTROLLER_METHOD_CAPABILITY)
      .filter(([, cap]) => cap !== 'account.read')
      .map(([, cap]) => cap);
    expect(new Set(mutating)).toEqual(new Set(SHADOW_ACTION_CAPABILITIES));
    expect(mutating).toHaveLength(6);
    expect(requiredCapabilityForMethod('controller.screen.view')).toBeNull();
    expect(requiredCapabilityForMethod('screen.view')).toBeNull();
    // holding screen.view does not permit any durable method
    expect(methodPermittedBy('controller.job.start', ['account.read', 'screen.view'])).toBe(false);
    expect(methodPermittedBy('controller.session.message', ['screen.view'])).toBe(false);
  });

  it('screen.view flows through the enrollment request/approve subset like any capability', () => {
    // requested + host-approved → granted
    const granted = intersectApprovedCapabilities(['screen.view', 'session.message'], ['screen.view']);
    expect(granted.ok).toBe(true);
    if (granted.ok) {
      // host approved only screen.view (not session.message) → account.read floor + screen.view
      expect(granted.capabilities).toEqual(['account.read', 'screen.view']);
      expect(screenViewPermittedBy(granted.capabilities)).toBe(true);
    }
    // requested but host did NOT approve → not granted, view stays disabled
    const denied = intersectApprovedCapabilities(['screen.view'], ['job.start']);
    expect(denied.ok).toBe(true);
    if (denied.ok) {
      expect(denied.capabilities).toEqual(['account.read']);
      expect(screenViewPermittedBy(denied.capabilities)).toBe(false);
    }
    // controller cannot self-grant: host offers screen.view but controller never requested it
    const notRequested = intersectApprovedCapabilities([], ['screen.view']);
    expect(notRequested.ok).toBe(true);
    if (notRequested.ok) expect(screenViewPermittedBy(notRequested.capabilities)).toBe(false);
  });

  it('legacy grants (no screen.view) canonicalise byte-identically and stay view-disabled', () => {
    // canonical string for pre-3D1 sets is unchanged (append is signature-compatible)
    const legacy = canonicalizeCapabilities(['job.start', 'account.read']);
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      expect(capabilitiesCanonicalString(legacy.capabilities)).toBe('capv1:account.read,job.start');
      expect(screenViewPermittedBy(legacy.capabilities)).toBe(false);
    }
    // the read floor alone never authorises viewing
    expect(screenViewPermittedBy(['account.read'])).toBe(false);
    // the full six-action set (no screen.view) never authorises viewing
    expect(screenViewPermittedBy(['account.read', ...SHADOW_ACTION_CAPABILITIES])).toBe(false);
  });

  it('screen.view canonicalises last and unknown screen-ish caps fail closed', () => {
    const all = canonicalizeCapabilities([...SHADOW_CAPABILITIES].reverse());
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.capabilities[all.capabilities.length - 1]).toBe('screen.view');
      expect(capabilitiesCanonicalString(all.capabilities)).toBe(
        'capv1:account.read,session.message,job.start,job.cancel,approval.respond,question.answer,session.autopilot.set,screen.view',
      );
    }
    expect(canonicalizeCapabilities(['screen.control'])).toMatchObject({ ok: false });
    expect(canonicalizeCapabilities(['screen.record'])).toMatchObject({ ok: false });
    expect(canonicalizeCapabilities(['screen.input'])).toMatchObject({ ok: false });
    expect(isKnownCapability('screen.input')).toBe(false);
  });
});
