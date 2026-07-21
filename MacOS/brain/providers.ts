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
import { isHeaderSafeSecret, isStrictAsciiSecret } from './header-safe.js';
import {
  isElectronV10,
  decryptElectronV10,
  legacyServiceForChannel,
  fetchLegacySafeStoragePassword,
} from './legacy-safe-storage.js';

export type ProviderId = 'anthropic' | 'openai' | 'fal' | 'github';

/** ok = decrypts (or migrates) to a usable, strict credential; missing =
    nothing stored; corrupt = a cipher is on disk but is unreadable / cannot be
    migrated (wrong-device MS1 key, tampered blob, un-decryptable legacy v10, or
    an untrusted plaintext row). A corrupt credential must be treated as NOT
    connected and require a reconnect — never silently repaired, never shown as
    connected, never decoded as arbitrary UTF-8 plaintext. */
export type KeyState = 'ok' | 'missing' | 'corrupt';

/** UI-facing connection state for a stored apiKey provider. */
export type ProviderConnState = 'connected' | 'missing' | 'reconnect';

/** The stored-credential secret markers, decoded from the cipher's first bytes:
      MS1 = new authenticated AES-256-GCM envelope (this app).
      v10 = legacy Electron/Chromium OSCrypt blob (migrate once, then MS1).
      plaintext = an unmarked row (e.g. the old passthrough shim) — NOT trusted. */
type CipherKind = 'ms1' | 'v10' | 'plaintext';

// Re-exported so every header-building caller shares one ByteString guard.
export { isHeaderSafeSecret };

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
  /** 'connected' = usable; 'reconnect' = a credential is stored but unreadable/
      un-migratable and the user must reconnect. Never carries secret content. */
  status: 'connected' | 'reconnect';
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

/** Outcome of reading/migrating a stored cipher.
      ok        → `key` is a usable strict credential (optionally `migratedCipherB64`
                  is the MS1 re-encryption to persist once).
      missing   → no cipher stored.
      reconnect → a cipher exists but is unreadable / un-migratable / untrusted. */
interface EvalResult { state: 'ok' | 'missing' | 'reconnect'; key?: string; migratedCipherB64?: string }

/** Classify a decoded cipher by its leading marker bytes (MS1 / v10 / other). */
function cipherKind(blob: Buffer): CipherKind {
  if (blob.length >= 3 && blob.subarray(0, 3).toString('latin1') === 'MS1') return 'ms1';
  if (isElectronV10(blob)) return 'v10';
  return 'plaintext';
}

export class Providers {
  constructor(private store: Store) {}

  /** Memoized read/migrate evaluation, keyed by `${provider}:${cipherB64}` so a
      status poll (list/keyState) does the expensive legacy decrypt at most once
      per distinct stored cipher. Cleared when a migration rewrites a row. */
  private evalCache = new Map<string, EvalResult>();
  /** The legacy Safe Storage master password, fetched at most once per process
      (undefined = not yet fetched, null = fetched-but-absent). Never logged. */
  private legacyPw: string | null | undefined = undefined;

  list(): ProviderConn[] {
    const out: ProviderConn[] = [];
    // A stored apiKey row is "connected" only if it decrypts (or migrates) to a
    // usable strict credential. If a cipher is present but unreadable it is
    // shown as 'reconnect' — NEVER silently omitted and NEVER shown connected,
    // so Settings/Onboarding tell the truth instead of failing every generation.
    if (claudeLoggedIn()) {
      out.push({ provider: 'anthropic', method: 'subscription', status: 'connected', detail: 'Claude Code login', createdAt: 0 });
    } else {
      this.pushApiKeyRow(out, 'anthropic');
    }
    if (codexLoggedIn()) {
      out.push({ provider: 'openai', method: 'subscription', status: 'connected', detail: 'Codex (ChatGPT) login', createdAt: 0 });
    } else {
      this.pushApiKeyRow(out, 'openai');
    }
    this.pushApiKeyRow(out, 'fal');
    // GitHub is entirely gh-CLI based — there is no stored PAT. `gh auth login`
    // is the single source of truth (the same offline `~/.config/gh/hosts.yml`
    // signal Settings and the topbar read), so the Accounts row shows
    // "Connected" whenever gh is signed in, regardless of the Mac Keychain.
    if (ghLoggedIn()) {
      out.push({ provider: 'github', method: 'subscription', status: 'connected', detail: 'gh CLI login', createdAt: 0 });
    }
    return out;
  }

  /** Append a truthful apiKey row for a stored-credential provider, or nothing
      when no credential is stored. A stored-but-unreadable credential yields a
      secret-free `reconnect` row (last4 kept for recognizability). */
  private pushApiKeyRow(out: ProviderConn[], provider: ProviderId): void {
    const meta = this.store.providerKeyMeta(provider);
    if (!meta) return;
    const state = this.providerState(provider);
    if (state === 'connected') {
      out.push({ provider, method: 'apiKey', status: 'connected', detail: `API key ••••${meta.last4}`, keyLast4: meta.last4, createdAt: meta.createdAt });
    } else if (state === 'reconnect') {
      out.push({ provider, method: 'apiKey', status: 'reconnect', detail: 'Reconnect required — the stored key can’t be read on this Mac.', keyLast4: meta.last4, createdAt: meta.createdAt });
    }
  }

  /** Validate against the LIVE provider API, then store encrypted locally. */
  async connect(provider: ProviderId, apiKey: string): Promise<ProviderConn> {
    // Trim only conventional accidental OUTER whitespace + a leading BOM (a
    // frequent copy-paste artifact) BEFORE validation. Interior bytes are never
    // mutated — we do not lossily normalize the secret itself.
    const key = apiKey.replace(/^﻿/, '').trim();
    if (!key) throw Object.assign(new Error('apiKey required'), { statusCode: 400 });
    // Strict credential policy: real FAL/Anthropic/OpenAI/GitHub tokens are
    // printable ASCII. Reject extended Latin-1, TAB, controls, DEL, interior
    // whitespace, U+FFFD and all non-ASCII up front — such a value could never
    // authenticate and (for >0xFF) would throw a native ByteString TypeError at
    // the Authorization header.
    if (!isStrictAsciiSecret(key)) throw Object.assign(new Error('That API key contains an invalid character and cannot be used. Paste the key again.'), { statusCode: 400 });
    const ok = await this.validate(provider, key);
    if (!ok.valid) throw Object.assign(new Error(ok.error ?? 'Invalid API key'), { statusCode: 400 });
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('Keychain encryption unavailable'), { statusCode: 500 });
    const cipherB64 = safeStorage.encryptString(key).toString('base64');
    this.store.setProviderKey(provider, cipherB64, key.slice(-4));
    this.evalCache.clear();
    const meta = this.store.providerKeyMeta(provider);
    return { provider, method: 'apiKey', status: 'connected', detail: `API key ••••${meta?.last4 ?? ''}`, keyLast4: meta?.last4, createdAt: meta?.createdAt ?? Date.now() };
  }

  disconnect(provider: ProviderId): void {
    this.store.deleteProviderKey(provider);
    this.evalCache.clear();
  }

  /** Store an already-trusted secret (e.g. a validated bot token) encrypted,
      without the provider-key validation path. Returns the stored last4. */
  setRawKey(provider: string, secret: string): string {
    if (!isStrictAsciiSecret(secret)) throw Object.assign(new Error('secret contains an invalid character'), { statusCode: 400 });
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('Keychain encryption unavailable'), { statusCode: 500 });
    const cipherB64 = safeStorage.encryptString(secret).toString('base64');
    this.store.setProviderKey(provider, cipherB64, secret.slice(-4));
    this.evalCache.clear();
    return secret.slice(-4);
  }
  getRawKey(provider: string): string | undefined {
    return this.readUsableKey(provider);
  }
  clearKey(provider: string): void { this.store.deleteProviderKey(provider); this.evalCache.clear(); }

  /** Whether a provider's stored credential is usable, absent, or corrupt.
      Drives the media engine's missing-vs-reconnect messaging. */
  keyState(provider: string): KeyState {
    const s = this.evaluate(provider).state;
    return s === 'ok' ? 'ok' : s === 'missing' ? 'missing' : 'corrupt';
  }

  /** UI-facing tri-state for a stored apiKey provider (list/Settings). */
  providerState(provider: string): ProviderConnState {
    const s = this.evaluate(provider).state;
    return s === 'ok' ? 'connected' : s === 'missing' ? 'missing' : 'reconnect';
  }

  getLocalKey(provider: ProviderId): string | undefined {
    // GitHub is ENTIRELY gh-CLI based: `gh` owns the auth and we only ever
    // borrow the live token from `gh auth token`. We never read a GitHub token
    // from the Keychain — that stored-cipher path produced wrong-signature
    // mojibake (U+FFFD) that poisoned the Authorization header. If a legacy
    // cipher from an older build is still on disk, drop it so nothing reads it
    // again, then hand back the clean gh token (or nothing if gh isn't authed).
    if (provider === 'github') {
      if (this.store.getProviderKeyCipher('github')) {
        try { this.store.deleteProviderKey('github'); this.evalCache.clear(); } catch { /* best effort */ }
      }
      const t = ghCliToken();
      return isCleanGithubToken(t) ? t : undefined;
    }
    return this.readUsableKey(provider);
  }

  /** Return the usable plaintext credential for a stored provider, performing a
      one-time legacy→MS1 migration on first successful read. Returns undefined
      when missing or unreadable (caller surfaces reconnect). */
  private readUsableKey(provider: string): string | undefined {
    const r = this.evaluate(provider);
    if (r.state !== 'ok' || !r.key) return undefined;
    // Lazily persist the migrated MS1 envelope exactly once, replacing ONLY this
    // row and preserving last4. If the write fails, keep the original untouched
    // and just return the key — the next read retries the migration.
    if (r.migratedCipherB64) {
      try {
        this.store.setProviderKey(provider, r.migratedCipherB64, r.key.slice(-4));
        this.evalCache.clear();
      } catch { /* leave original ciphertext intact */ }
    }
    return r.key;
  }

  /** Cached read/migrate evaluation for a stored provider row. */
  private evaluate(provider: string): EvalResult {
    const cipher = this.store.getProviderKeyCipher(provider);
    if (!cipher) return { state: 'missing' };
    const cacheKey = `${provider}:${cipher}`;
    const hit = this.evalCache.get(cacheKey);
    if (hit) return hit;
    const r = this.evaluateUncached(cipher, this.store.providerKeyMeta(provider)?.last4);
    this.evalCache.set(cacheKey, r);
    return r;
  }

  private evaluateUncached(cipher: string, expectedLast4?: string): EvalResult {
    let blob: Buffer;
    try { blob = Buffer.from(cipher, 'base64'); } catch { return { state: 'reconnect' }; }
    switch (cipherKind(blob)) {
      case 'ms1': {
        // New envelope: decrypt under the Keychain master key. Auth failure
        // (wrong device / tamper) or a non-header-safe result → reconnect.
        try {
          const v = safeStorage.decryptString(blob);
          return isHeaderSafeSecret(v) ? { state: 'ok', key: v } : { state: 'reconnect' };
        } catch { return { state: 'reconnect' }; }
      }
      case 'v10': {
        // Legacy Electron blob: decrypt with the OSCrypt master password, then
        // re-encrypt as MS1. Only accept a STRICT printable-ASCII credential —
        // never fall back to arbitrary UTF-8 plaintext.
        try {
          const pw = this.legacyPassword();
          if (!pw) return { state: 'reconnect' };
          const pt = decryptElectronV10(blob, pw).toString('utf8');
          if (!isStrictAsciiSecret(pt) || !isHeaderSafeSecret(pt)) return { state: 'reconnect' };
          // AES-128-CBC v10 has NO authentication tag — only PKCS#7 padding — so a
          // wrong/tampered master password can occasionally decrypt to valid
          // padding AND printable bytes. Bind the plaintext to the stored
          // metadata: its last-4 MUST match the recorded `last4` the real key was
          // saved with, or we refuse to migrate/serve it (fail closed → reconnect).
          if (!expectedLast4 || pt.slice(-4) !== expectedLast4) return { state: 'reconnect' };
          let migratedCipherB64: string | undefined;
          try {
            if (safeStorage.isEncryptionAvailable()) migratedCipherB64 = safeStorage.encryptString(pt).toString('base64');
          } catch { /* no master key → keep original, still usable this run */ }
          return { state: 'ok', key: pt, migratedCipherB64 };
        } catch { return { state: 'reconnect' }; }
      }
      default:
        // Unmarked (e.g. the old passthrough shim's base64 plaintext). Security
        // wins: do NOT trust a plaintext row — require a reconnect.
        return { state: 'reconnect' };
    }
  }

  private legacyPassword(): string | undefined {
    if (this.legacyPw === undefined) {
      const service = legacyServiceForChannel(process.env.MAESTRO_CHANNEL);
      this.legacyPw = fetchLegacySafeStoragePassword(service) ?? null;
    }
    return this.legacyPw ?? undefined;
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
