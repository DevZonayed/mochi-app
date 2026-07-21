import { describe, it, expect } from 'vitest';
import { legacyIntentFromJob, mergeRunIntent, normalizeRunIntent } from './run-intent.js';

describe('RunIntent normalization', () => {
  it('preserves explicit false and reviewer off', () => {
    const intent = normalizeRunIntent({
      effort: 'deep',
      engine: 'claude',
      model: 'claude-opus-4-8',
      reviewer: 'off',
      plan: false,
      goal: false,
      browser: false,
    }, 'balanced');

    expect(intent).toEqual({
      schemaVersion: 1,
      effort: 'deep',
      engine: 'claude',
      model: 'claude-opus-4-8',
      reviewer: 'off',
      plan: false,
      goal: false,
      browser: false,
    });
  });

  it('normalizes an invalid fallback effort to balanced instead of persisting it', () => {
    expect(normalizeRunIntent(undefined, 'turbo' as never)).toEqual({
      schemaVersion: 1,
      effort: 'balanced',
    });
  });

  it('merges with undefined as inherit and explicit values as override', () => {
    const base = normalizeRunIntent({
      effort: 'deep',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: { engine: 'claude', model: 'claude-sonnet-4-5' },
      plan: true,
      goal: false,
      browser: true,
    }, 'balanced');

    expect(mergeRunIntent(base, { effort: 'fast', plan: false, goal: true, browser: undefined }, 'balanced')).toEqual({
      schemaVersion: 1,
      effort: 'fast',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: { engine: 'claude', model: 'claude-sonnet-4-5' },
      plan: false,
      goal: true,
      browser: true,
    });
  });

  it('legacy migration only backfills persisted job evidence', () => {
    expect(legacyIntentFromJob({ effort: 'max', engine: 'codex', model: 'gpt-5', goal: true })).toEqual({
      schemaVersion: 1,
      effort: 'max',
      engine: 'codex',
      model: 'gpt-5',
      goal: true,
    });
  });
});
