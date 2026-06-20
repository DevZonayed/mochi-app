import { describe, test, expect } from 'vitest';
import { DEFAULT_RUN_MODE, normalizeRunMode, canStartBackgroundRun } from './run-mode.js';

describe('normalizeRunMode', () => {
  test('only "nonconcurrent" is nonconcurrent; everything else is concurrent', () => {
    expect(normalizeRunMode('nonconcurrent')).toBe('nonconcurrent');
    expect(normalizeRunMode('concurrent')).toBe('concurrent');
    expect(normalizeRunMode(undefined)).toBe(DEFAULT_RUN_MODE);
    expect(normalizeRunMode('garbage')).toBe('concurrent');
    expect(DEFAULT_RUN_MODE).toBe('concurrent');
  });
});

describe('canStartBackgroundRun', () => {
  test('concurrent always allows', () => {
    expect(canStartBackgroundRun({ mode: 'concurrent', sessionId: 's1', activeSessionIds: ['s2', 's3'] }))
      .toEqual({ allowed: true, blockedBy: null });
  });
  test('nonconcurrent allows when no OTHER session is running', () => {
    expect(canStartBackgroundRun({ mode: 'nonconcurrent', sessionId: 's1', activeSessionIds: [] }))
      .toEqual({ allowed: true, blockedBy: null });
  });
  test('nonconcurrent allows the SAME session to start another process', () => {
    expect(canStartBackgroundRun({ mode: 'nonconcurrent', sessionId: 's1', activeSessionIds: ['s1', 's1'] }))
      .toEqual({ allowed: true, blockedBy: null });
  });
  test('nonconcurrent blocks when another session already runs one', () => {
    expect(canStartBackgroundRun({ mode: 'nonconcurrent', sessionId: 's1', activeSessionIds: ['s2'] }))
      .toEqual({ allowed: false, blockedBy: 's2' });
  });
});
