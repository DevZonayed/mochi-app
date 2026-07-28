import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  systemBinary: vi.fn(),
  managedBinary: vi.fn(),
  bundledBinary: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: hoisted.execFileSync };
});

vi.mock('./engines.js', () => ({
  systemBinary: hoisted.systemBinary,
  managedBinary: hoisted.managedBinary,
  bundledBinary: hoisted.bundledBinary,
  enginesRoot: () => '/engines',
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    models = { list: async function* () { /* no API-key models in this unit test */ } };
  },
}), { virtual: true });

import { buildModelGroups, keyForRun, refreshModelGroups, resolveModelKey } from './models.js';

describe('provider-owned model registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.systemBinary.mockImplementation((id: string) => id === 'claude' ? '/bin/claude' : id === 'codex' ? '/bin/codex' : null);
    hoisted.managedBinary.mockReturnValue(null);
    hoisted.bundledBinary.mockReturnValue(null);
    hoisted.execFileSync.mockImplementation((cmd: string) => {
      if (cmd === '/bin/codex') {
        return JSON.stringify({
          models: [
            { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 7 },
            { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 8 },
            { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 2 },
            { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 1 },
          ],
        });
      }
      throw new Error('not found');
    });
  });

  it('prefers Claude aliases and discovers the live Codex CLI catalog', async () => {
    await refreshModelGroups(undefined, { force: true });
    const groups = buildModelGroups({
      claude: { available: true, reason: '' },
      codex: { available: true, reason: '' },
    });

    const claude = groups.find((g) => g.provider === 'claude');
    expect(claude?.models.map((m) => m.key)).toEqual(['claude:opus', 'claude:fable', 'claude:sonnet', 'claude:haiku']);
    expect(claude?.models[0]).toMatchObject({ id: 'opus', label: 'Claude Opus 5', badge: 'NEW' });
    expect(hoisted.execFileSync).not.toHaveBeenCalledWith('/usr/bin/strings', expect.anything(), expect.anything());

    const codex = groups.find((g) => g.provider === 'codex');
    expect(codex?.label).toBe('Codex models');
    expect(codex?.models.map((m) => m.key)).toEqual(['codex:gpt-5.6-sol', 'codex:gpt-5.6-terra', 'codex:gpt-5.5']);
    expect(codex?.models[0]).toMatchObject({ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', badge: 'NEW' });

    expect(resolveModelKey('claude:opus')).toEqual({ engine: 'claude', model: 'opus' });
    expect(keyForRun('claude', 'opus')).toBe('claude:opus');
    expect(keyForRun('codex', 'gpt-5.6-sol')).toBe('codex:gpt-5.6-sol');
  });
});
