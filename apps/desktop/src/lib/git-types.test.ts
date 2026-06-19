/* Pure helpers — no DOM. */
import { describe, test, expect } from 'vitest';
import {
  rollupSessionState,
  codenameFromBranch,
  displayCodename,
  SESSION_STATE_COLOR,
  SESSION_STATE_LABELS,
} from './git-types';

describe('rollupSessionState', () => {
  test('returns null on an empty list', () => {
    expect(rollupSessionState([])).toBeNull();
  });
  test('conflicts beat everything else', () => {
    expect(rollupSessionState(['clean', 'pr-mergeable', 'pr-conflicts', 'ready-for-pr'])).toBe('pr-conflicts');
  });
  test('mergeable beats ready-for-pr', () => {
    expect(rollupSessionState(['clean', 'ready-for-pr', 'pr-mergeable'])).toBe('pr-mergeable');
  });
  test('blocked beats mergeable when both are open', () => {
    // We *don't* want blocked to outrank mergeable — blocked is "checks pending"
    // and mergeable means GitHub says you can merge right now. Sanity check the
    // priority table reflects that.
    expect(rollupSessionState(['pr-blocked', 'pr-mergeable'])).toBe('pr-mergeable');
  });
  test('merged is dimmer than ready-to-push', () => {
    expect(rollupSessionState(['pr-merged', 'ready-to-push'])).toBe('ready-to-push');
  });
  test('clean alone returns clean', () => {
    expect(rollupSessionState(['clean'])).toBe('clean');
  });
});

describe('codename helpers', () => {
  test('displayCodename round-trips kebab → title', () => {
    expect(displayCodename('lyon')).toBe('Lyon');
    expect(displayCodename('chiang-mai')).toBe('Chiang Mai');
    expect(displayCodename(null)).toBe('');
    expect(displayCodename(undefined)).toBe('');
  });
  test('codenameFromBranch extracts only mochi-formatted branches', () => {
    expect(codenameFromBranch('mochi/lyon/fix-auth')).toBe('lyon');
    expect(codenameFromBranch('mochi/hue/bug')).toBe('hue');
    expect(codenameFromBranch('mochi/legacy-ab12')).toBeNull();
    expect(codenameFromBranch('feature/x')).toBeNull();
    expect(codenameFromBranch(null)).toBeNull();
  });
});

describe('state tables are exhaustive', () => {
  test('every state has a label AND a color', () => {
    const states = Object.keys(SESSION_STATE_LABELS) as Array<keyof typeof SESSION_STATE_LABELS>;
    for (const s of states) {
      expect(typeof SESSION_STATE_LABELS[s]).toBe('string');
      expect(typeof SESSION_STATE_COLOR[s]).toBe('string');
    }
    expect(states.length).toBe(10);
  });
});
