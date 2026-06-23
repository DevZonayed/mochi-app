import { describe, it, expect } from 'vitest';
import { thinkingConfigFor, EFFORT_THINKING_TOKENS } from './thinking-config.js';

describe('thinkingConfigFor', () => {
  it('returns adaptive for Opus (the SDK default for 4.6+)', () => {
    expect(thinkingConfigFor('opus', 'balanced')).toEqual({ type: 'adaptive' });
    expect(thinkingConfigFor('claude-opus-4-6', 'deep')).toEqual({ type: 'adaptive' });
    // Case insensitivity — the routing store sometimes capitalizes the slug.
    expect(thinkingConfigFor('Opus', 'fast')).toEqual({ type: 'adaptive' });
  });

  it('returns adaptive when no model override is provided (SDK fallback)', () => {
    // No override → the Claude binary picks its default, which is Opus 4.6+
    // today and adaptive-capable. We make that explicit instead of relying on
    // an implicit SDK default that could change.
    expect(thinkingConfigFor(undefined, 'balanced')).toEqual({ type: 'adaptive' });
    expect(thinkingConfigFor('', 'balanced')).toEqual({ type: 'adaptive' });
  });

  it('forces a fixed budget on Sonnet so thinking_delta still streams', () => {
    expect(thinkingConfigFor('sonnet', 'fast')).toEqual({ type: 'enabled', budgetTokens: EFFORT_THINKING_TOKENS.fast });
    expect(thinkingConfigFor('claude-sonnet-4-5', 'balanced')).toEqual({ type: 'enabled', budgetTokens: EFFORT_THINKING_TOKENS.balanced });
    expect(thinkingConfigFor('sonnet', 'deep')).toEqual({ type: 'enabled', budgetTokens: EFFORT_THINKING_TOKENS.deep });
    expect(thinkingConfigFor('sonnet', 'max')).toEqual({ type: 'enabled', budgetTokens: EFFORT_THINKING_TOKENS.max });
  });

  it('forces a fixed budget on Haiku as well', () => {
    expect(thinkingConfigFor('haiku', 'balanced')).toEqual({ type: 'enabled', budgetTokens: EFFORT_THINKING_TOKENS.balanced });
  });

  it('falls back to a safe 4000-token budget for unknown efforts', () => {
    // An unrecognised effort label (e.g. a future addition we forgot to map)
    // mustn't crash or pass `budgetTokens: NaN` to the SDK.
    expect(thinkingConfigFor('sonnet', 'who-knows')).toEqual({ type: 'enabled', budgetTokens: 4000 });
  });

  it('scales budget monotonically with effort', () => {
    // The whole point of the effort knob — more effort, more thinking budget.
    expect(EFFORT_THINKING_TOKENS.fast).toBeLessThan(EFFORT_THINKING_TOKENS.balanced);
    expect(EFFORT_THINKING_TOKENS.balanced).toBeLessThan(EFFORT_THINKING_TOKENS.deep);
    expect(EFFORT_THINKING_TOKENS.deep).toBeLessThan(EFFORT_THINKING_TOKENS.max);
  });
});
