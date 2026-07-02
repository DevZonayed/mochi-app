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
import { ghCliToken, ghLoggedIn } from './github-auth.js';

export type ProviderId = 'anthropic' | 'openai' | 'fal' | 'github';

/** A decrypted GitHub token must be printable ASCII (all real formats —
    `ghp_`, `gho_`, `ghs_`, `github_pat_` — are `[A-Za-z0-9_]`). Electron's
    `safeStorage.decryptString` can "succeed" yet return mojibake with U+FFFD
    replacement chars when the ciphertext was written under a DIFFERENT app
    signature (ad-hoc-signed rebuilds whose Keychain ACL changed between
    builds). Handing that poisoned string to the GitHub API blows up the
    Authorization header ("Cannot convert argument to a ByteString") and makes
    push / PR / status all fail while Settings still reads "connected" from the
    on-disk gh login. This guard rejects such garbage so callers fall back to
    the clean `gh` CLI token. */
export function isCleanGithubToken(s: string | undefined | null): s is string {
  return typeof s === 'string' && s.length >= 20 && /^[\x21-\x7E]+$/.test(s);
}

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
    // GitHub is entirely gh-CLI based — there is no stored PAT. `gh auth login`
    // is the single source of truth (the same offline `~/.config/gh/hosts.yml`
    // signal Settings and the topbar read), so the Accounts row shows
    // "Connected" whenever gh is signed in, regardless of the Mac Keychain.
    if (ghLoggedIn()) {
      out.push({ provider: 'github', method: 'subscription', status: 'connected', detail: 'gh CLI login', createdAt: 0 });
    }
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

  /** Store an already-trusted secret (e.g. a validated bot token) encrypted,
      without the provider-key validation path. Returns the stored last4. */
  setRawKey(provider: string, secret: string): string {
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('Keychain encryption unavailable'), { statusCode: 500 });
    const cipherB64 = safeStorage.encryptString(secret).toString('base64');
    this.store.setProviderKey(provider, cipherB64, secret.slice(-4));
    return secret.slice(-4);
  }
  getRawKey(provider: string): string | undefined {
    const cipher = this.store.getProviderKeyCipher(provider);
    if (!cipher) return undefined;
    try { return safeStorage.decryptString(Buffer.from(cipher, 'base64')); } catch { return undefined; }
  }
  clearKey(provider: string): void { this.store.deleteProviderKey(provider); }

  getLocalKey(provider: ProviderId): string | undefined {
    // GitHub is ENTIRELY gh-CLI based: `gh` owns the auth and we only ever
    // borrow the live token from `gh auth token`. We never read a GitHub token
    // from the Keychain — that stored-cipher path produced wrong-signature
    // mojibake (U+FFFD) that poisoned the Authorization header. If a legacy
    // cipher from an older build is still on disk, drop it so nothing reads it
    // again, then hand back the clean gh token (or nothing if gh isn't authed).
    if (provider === 'github') {
      if (this.store.getProviderKeyCipher('github')) {
        try { this.store.deleteProviderKey('github'); } catch { /* best effort */ }
      }
      const t = ghCliToken();
      return isCleanGithubToken(t) ? t : undefined;
    }
    const cipher = this.store.getProviderKeyCipher(provider);
    if (cipher) {
      try { return safeStorage.decryptString(Buffer.from(cipher, 'base64')); } catch { /* unreadable */ }
    }
    return undefined;
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
      if (provider === 'github') {
        // Validate a Personal Access Token against the authenticated-user endpoint.
        const res = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${key}`, accept: 'application/vnd.github+json', 'user-agent': 'maestro' } });
        if (res.ok) return { valid: true };
        if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid GitHub token' };
        return { valid: false, error: `GitHub returned ${res.status}` };
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
