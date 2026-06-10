import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type ProviderId = 'anthropic' | 'openai';

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  defaultModel: string;
  keyHint: string;
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  anthropic: { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-opus-4-8', keyHint: 'sk-ant-…' },
  openai: { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o', keyHint: 'sk-…' },
};

export function isProviderId(x: string): x is ProviderId {
  return x === 'anthropic' || x === 'openai';
}

/** Validate a key against the LIVE provider API (cheap models.list call). */
export async function validateProviderKey(provider: ProviderId, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === 'anthropic') {
      const client = new Anthropic({ apiKey });
      await client.models.list({ limit: 1 });
      return { ok: true };
    }
    const client = new OpenAI({ apiKey });
    await client.models.list();
    return { ok: true };
  } catch (e: unknown) {
    const status = (e as { status?: number })?.status;
    if (status === 401 || status === 403) return { ok: false, error: 'Invalid API key' };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not reach provider' };
  }
}
