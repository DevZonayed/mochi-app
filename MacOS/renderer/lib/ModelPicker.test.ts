import { describe, expect, it } from 'vitest';
import { keyForRoleChoice, normalizeModelKey } from './ModelPicker';
import type { ModelGroup } from './api';

const groups: ModelGroup[] = [
  {
    provider: 'claude',
    label: 'Claude models',
    runnable: true,
    reason: '',
    models: [
      { key: 'claude:opus', id: 'opus', label: 'Claude Opus 5', provider: 'claude' },
      { key: 'claude:sonnet', id: 'sonnet', label: 'Claude Sonnet 5', provider: 'claude' },
    ],
  },
];

describe('ModelPicker key normalization', () => {
  it('maps old saved Claude keys to current Claude Code aliases', () => {
    expect(normalizeModelKey('claude:claude-opus-4-8')).toBe('claude:opus');
    expect(normalizeModelKey('claude:claude-sonnet-5')).toBe('claude:sonnet');
  });

  it('falls forward from stale role models to the current provider default', () => {
    expect(keyForRoleChoice(groups, { engine: 'claude', model: 'claude-opus-4-8' })).toBe('claude:opus');
  });
});
