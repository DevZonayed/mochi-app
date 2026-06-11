/* Provider connections — ALL local to this Mac.

   Primary method: the CLI logins you already have (Claude Code `claude login`
   subscription session, Codex `codex` ChatGPT sign-in). Detected from disk;
   nothing to paste. Optional fallback: an API key validated live and stored
   encrypted with Electron safeStorage (macOS Keychain-backed) in the local
   store. Keys/sessions NEVER leave this Mac — the relay only sees status. */

import { safeStorage } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store.js';

export type ProviderId = 'anthropic' | 'openai' | 'fal';

export interface ProviderConn {
  provider: ProviderId;
  method: 'subscription' | 'apiKey';
  status: 'connected';
  detail: string;
  keyLast4?: string;
  createdAt: number;
}

export function claudeLoggedIn(): boolean {
  const h = homedir();
  return existsSync(join(h, '.claude.json')) || existsSync(join(h, '.claude'));
}
export function codexLoggedIn(): boolean {
  return existsSync(join(homedir(), '.codex', 'auth.json'));
}

export class Providers {
  constructor(private store: Store) {}

  list(): ProviderConn[] {
    const out: ProviderConn[] = [];
    if (claudeLoggedIn()) {
      out.push({ provider: 'anthropic', method: 'subscription', status: 'connected', detail: 'Claude Code login', createdAt: 0 });
    } else {
      const k = this.store.providerKeyMeta('anthropic');
      if (k) out.push({ provider: 'anthropic', method: 'apiKey', status: 'connected', detail: `API key ••••${k.last4}`, keyLast4: k.last4, createdAt: k.createdAt });
    }
    if (codexLoggedIn()) {
      out.push({ provider: 'openai', method: 'subscription', status: 'connected', detail: 'Codex (ChatGPT) login', createdAt: 0 });
    } else {
      const k = this.store.providerKeyMeta('openai');
      if (k) out.push({ provider: 'openai', method: 'apiKey', status: 'connected', detail: `API key ••••${k.last4}`, keyLast4: k.last4, createdAt: k.createdAt });
    }
    const fal = this.store.providerKeyMeta('fal');
    if (fal) out.push({ provider: 'fal', method: 'apiKey', status: 'connected', detail: `API key ••••${fal.last4}`, keyLast4: fal.last4, createdAt: fal.createdAt });
    return out;
  }

  /** Validate against the LIVE provider API, then store encrypted locally. */
  async connect(provider: ProviderId, apiKey: string): Promise<ProviderConn> {
    const key = apiKey.trim();
    if (!key) throw Object.assign(new Error('apiKey required'), { statusCode: 400 });
    const ok = await this.validate(provider, key);
    if (!ok.valid) throw Object.assign(new Error(ok.error ?? 'Invalid API key'), { statusCode: 400 });
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('Keychain encryption unavailable'), { statusCode: 500 });
    const cipherB64 = safeStorage.encryptString(key).toString('base64');
    this.store.setProviderKey(provider, cipherB64, key.slice(-4));
    const meta = this.store.providerKeyMeta(provider);
    return { provider, method: 'apiKey', status: 'connected', detail: `API key ••••${meta?.last4 ?? ''}`, keyLast4: meta?.last4, createdAt: meta?.createdAt ?? Date.now() };
  }

  disconnect(provider: ProviderId): void {
    this.store.deleteProviderKey(provider);
  }

  getLocalKey(provider: ProviderId): string | undefined {
    const cipher = this.store.getProviderKeyCipher(provider);
    if (!cipher) return undefined;
    try { return safeStorage.decryptString(Buffer.from(cipher, 'base64')); } catch { return undefined; }
  }

  private async validate(provider: ProviderId, key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      if (provider === 'fal') {
        // Zero-cost auth check: a bogus request id 401s on a bad key, 404s on a
        // good one (request not found). Anything other than 401/403 = authed.
        const res = await fetch('https://queue.fal.run/fal-ai/flux/schnell/requests/00000000-0000-0000-0000-000000000000/status', { headers: { authorization: `Key ${key}` } });
        if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid fal API key' };
        return { valid: true };
      }
      const res = provider === 'anthropic'
        ? await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } })
        : await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
      if (res.ok) return { valid: true };
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
      return { valid: false, error: `Provider returned ${res.status}` };
    } catch {
      return { valid: false, error: 'Could not reach provider' };
    }
  }
}
