import { describe, test, expect } from 'vitest';
import {
  PORT_RANGE_START, PORT_RANGE_END, PORT_SPAN, PORT_BUCKETS,
  hashString, preferredPortBase, allocatePortBase, sessionPortEnv,
} from './session-ports.js';

describe('hashString', () => {
  test('is deterministic and unsigned', () => {
    expect(hashString('a/b')).toBe(hashString('a/b'));
    expect(hashString('a/b')).toBeGreaterThanOrEqual(0);
  });
  test('differs for different inputs', () => {
    expect(hashString('p1/s1')).not.toBe(hashString('p1/s2'));
  });
});

describe('preferredPortBase', () => {
  test('is stable for the same session and inside the range, aligned to PORT_SPAN', () => {
    const base = preferredPortBase('p1', 's1');
    expect(base).toBe(preferredPortBase('p1', 's1'));
    expect(base).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(base).toBeLessThan(PORT_RANGE_END);
    expect((base - PORT_RANGE_START) % PORT_SPAN).toBe(0);
  });
});

describe('allocatePortBase', () => {
  test('returns the preferred base when free', () => {
    const pref = preferredPortBase('p1', 's1');
    expect(allocatePortBase('p1', 's1', new Set())).toBe(pref);
  });
  test('probes to a different free block when the preferred one is taken', () => {
    const pref = preferredPortBase('p1', 's1');
    const got = allocatePortBase('p1', 's1', new Set([pref]));
    expect(got).not.toBe(pref);
    expect((got - PORT_RANGE_START) % PORT_SPAN).toBe(0);
    expect(got).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(got).toBeLessThan(PORT_RANGE_END);
  });
  test('never returns a taken block until the range is exhausted', () => {
    const taken = new Set<number>();
    const bases: number[] = [];
    for (let i = 0; i < 50; i++) {
      const b = allocatePortBase('p1', `s${i}`, taken);
      expect(taken.has(b)).toBe(false);
      taken.add(b);
      bases.push(b);
    }
    expect(new Set(bases).size).toBe(50); // all distinct
  });
});

describe('sessionPortEnv', () => {
  test('emits the MOCHI_* contract with a 10-port range', () => {
    const env = sessionPortEnv({ portBase: 41000, workspacePath: '/wt/p1/s1', projectId: 'p1', sessionId: 's1', defaultBranch: 'main' });
    expect(env.MOCHI_PORT).toBe('41000');
    expect(env.MOCHI_PORT_RANGE).toBe(`41000-${41000 + PORT_SPAN - 1}`);
    expect(env.MOCHI_WORKSPACE_PATH).toBe('/wt/p1/s1');
    expect(env.MOCHI_PROJECT_ID).toBe('p1');
    expect(env.MOCHI_SESSION_ID).toBe('s1');
    expect(env.MOCHI_DEFAULT_BRANCH).toBe('main');
    expect(env.MOCHI_IS_LOCAL).toBe('1');
  });
  test('defaults blank ids and remote flag cleanly', () => {
    const env = sessionPortEnv({ portBase: 41010, workspacePath: '/wt', projectId: null, sessionId: null, isLocal: false });
    expect(env.MOCHI_PROJECT_ID).toBe('');
    expect(env.MOCHI_SESSION_ID).toBe('');
    expect(env.MOCHI_DEFAULT_BRANCH).toBe('');
    expect(env.MOCHI_IS_LOCAL).toBe('0');
  });
});

test('range constants are coherent', () => {
  expect(PORT_BUCKETS).toBe(Math.floor((PORT_RANGE_END - PORT_RANGE_START) / PORT_SPAN));
  expect(PORT_BUCKETS).toBeGreaterThan(100);
});
