/**
 * shadowActionCapabilities.test.ts — Phase 3C3. The six action families map EXACTLY onto the
 * shared canonical capability/method contract; the enrollment "Control actions" request is
 * built least-privilege (read floor + only selected), deduped; granted controls derive from
 * the verified grant, never a requested/static list.
 */
import { describe, it, expect } from 'vitest';
import { CONTROLLER_METHOD_CAPABILITY, SHADOW_CAPABILITIES } from '@maestro/realtime/shadowCapabilities';
import {
  ACTION_FAMILIES, READ_FLOOR, requestedCapabilitiesFor, grantedActionFamilies, grantAllows,
} from './shadowActionCapabilities';

describe('canonical contract sync', () => {
  it('has exactly the six controllable families', () => {
    expect(ACTION_FAMILIES.map((f) => f.key).sort()).toEqual(
      ['answer-question', 'cancel-job', 'respond-approval', 'send-message', 'set-autopilot', 'start-job'],
    );
  });
  it('every family maps to the exact shared capability + method (no aliases/invented commands)', () => {
    for (const f of ACTION_FAMILIES) {
      expect(CONTROLLER_METHOD_CAPABILITY[f.method]).toBe(f.capability);
      expect(SHADOW_CAPABILITIES).toContain(f.capability);
    }
  });
  it('there is NO schedule capability/method in the canonical contract (schedules read-only)', () => {
    expect(ACTION_FAMILIES.some((f) => /schedule/i.test(f.key) || /schedule/i.test(f.method))).toBe(false);
    expect(Object.keys(CONTROLLER_METHOD_CAPABILITY).some((m) => /schedule/i.test(m))).toBe(false);
  });
});

describe('requestedCapabilitiesFor (least-privilege request)', () => {
  it('view mode requests ONLY the read floor', () => {
    expect(requestedCapabilitiesFor('view', ['start-job', 'cancel-job'])).toEqual([READ_FLOOR]);
  });
  it('control mode requests read floor + only the selected families, deduped', () => {
    const caps = requestedCapabilitiesFor('control', ['start-job', 'send-message']);
    expect(caps).toContain('account.read');
    expect(caps).toContain('job.start');
    expect(caps).toContain('session.message');
    expect(caps).not.toContain('job.cancel');
    expect(new Set(caps).size).toBe(caps.length); // deduped
  });
  it('control with nothing selected is still only the read floor (no silent all-select)', () => {
    expect(requestedCapabilitiesFor('control', [])).toEqual([READ_FLOOR]);
  });
  it('duplicate selections collapse', () => {
    expect(requestedCapabilitiesFor('control', ['start-job', 'start-job'])).toEqual(['account.read', 'job.start']);
  });
});

describe('granted derivation (never requested/static)', () => {
  it('grantedActionFamilies reflects only the verified grant', () => {
    expect(grantedActionFamilies(['account.read', 'job.start']).map((f) => f.key)).toEqual(['start-job']);
    expect(grantedActionFamilies(['account.read']).map((f) => f.key)).toEqual([]);
    expect(grantedActionFamilies(null)).toEqual([]);
  });
  it('grantAllows gates each family on the exact granted capability', () => {
    expect(grantAllows(['account.read', 'approval.respond'], 'respond-approval')).toBe(true);
    expect(grantAllows(['account.read', 'approval.respond'], 'start-job')).toBe(false);
    expect(grantAllows(null, 'start-job')).toBe(false);
    expect(grantAllows([], 'send-message')).toBe(false);
  });
});
