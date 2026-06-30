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

export interface ProviderConn {
  provider: ProviderId;
  method: 'subscription' | 'apiKey';
  status: 'connected';
  detail: string;
  keyLast4?: string;
  createdAt: number;
}

/** A decrypted secret is only usable if it's non-empty and pure printable
    ASCII. A corrupted Keychain blob (e.g. after an ad-hoc-signing re-key, see
    the Safe Storage prompt memo) can decrypt WITHOUT throwing yet come back
    carrying U+FFFD replacement chars. Tokens/keys are always ASCII, so anything
    outside 0x20–0x7E means the blob is garbage — and feeding it into an HTTP
    `Authorization` header throws the opaque "Cannot convert argument to a
    ByteString … value 65533" error (a failed PR/clone with no actionable cause).
    Rejecting it here lets callers fall back to a CLI-sourced token instead. */
export function isUsableSecret(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.length > 0 && /^[\x20-\x7E]+$/.test(s);
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
    // GitHub: prefer the gh CLI as source-of-truth (mirrors how anthropic/openai
    // detect their CLI logins). This makes the Accounts row show "Connected"
    // even when Safe Storage isn't available — e.g. ad-hoc-signed builds whose
    // Keychain ACL the user dismissed — so users aren't locked out of git/PR
    // operations by a Mac Keychain quirk they can't be expected to debug.
    if (ghLoggedIn()) {
      out.push({ provider: 'github', method: 'subscription', status: 'connected', detail: 'gh CLI login', createdAt: 0 });
    } else {
      const gh = this.store.providerKeyMeta('github');
      if (gh) out.push({ provider: 'github', method: 'apiKey', status: 'connected', detail: `PAT ••••${gh.last4}`, keyLast4: gh.last4, createdAt: gh.createdAt });
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
    try {
      const dec = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
      return isUsableSecret(dec) ? dec : undefined;
    } catch { return undefined; }
  }
  clearKey(provider: string): void { this.store.deleteProviderKey(provider); }

  getLocalKey(provider: ProviderId): string | undefined {
    const cipher = this.store.getProviderKeyCipher(provider);
    if (cipher) {
      try {
        const dec = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
        // Only trust a decrypt that yields a sane ASCII secret. A corrupted blob
        // decrypts to U+FFFD-laced garbage WITHOUT throwing; returning it would
        // blow up the Authorization header. Fall through to the CLI token (gh
        // auth) instead — for GitHub that's an equally-valid source.
        if (isUsableSecret(dec)) return dec;
      } catch { /* fall through to CLI */ }
    }
    // gh CLI is a valid source of the GitHub token (same as ~/.claude.json
    // for anthropic / ~/.codex for openai). All three callers — GitService
    // for PRs, githubStatus, feedbackCreateIssue — get unblocked when Safe
    // Storage write/read fails but `gh auth login` succeeded on disk.
    if (provider === 'github') {
      const t = ghCliToken();
      if (t) return t;
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
