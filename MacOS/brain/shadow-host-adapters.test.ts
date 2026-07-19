/**
 * Production desktop adapter tests. The safeStorage platform seam is mocked with
 * the REAL MS1 AES-256-GCM crypto (`safe-storage-crypto`) under a random key, so
 * the only thing "mocked" is the Keychain master-key source. Proves ciphertext at
 * rest, fail-closed on wrong-key/tamper/unavailable, atomic 0600 writes, malformed
 * recovery + bounds, and — end to end through the real runtime — that no private
 * seed or scope key is ever written in plaintext.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { encryptWithKey, decryptWithKey } from '../sidecar/src/safe-storage-crypto.ts';
import { SafeStorageVault, FileHostEnrollmentPersistence, type SafeStorageLike } from './shadow-host-adapters.ts';
import { ShadowHostEnrollmentRuntime, type HostEnrollmentRecord } from './shadow-enrollment-host.ts';
import type { ShadowFetch } from '@maestro/realtime/shadowRequestClient';
import type { Fence } from '@maestro/realtime/shadowProtocol';

/** Mock safeStorage: real MS1 crypto, random key — only the master-key source is faked. */
function mockSafeStorage(available = true): SafeStorageLike & { available: boolean; key: Buffer } {
  return {
    available,
    key: randomBytes(32),
    isEncryptionAvailable() { return this.available; },
    encryptString(s: string) { return new Uint8Array(encryptWithKey(this.key, s)); },
    decryptString(b: Uint8Array) { return decryptWithKey(this.key, Buffer.from(b)); },
  };
}

function tmpFile(name = 'rec.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'shadow-host-')), name);
}

describe('SafeStorageVault', () => {
  it('encrypts at rest and round-trips', () => {
    const ss = mockSafeStorage();
    const vault = new SafeStorageVault(ss);
    const secret = 'super-secret-seed-material';
    const ct = vault.encryptString(secret);
    expect(Buffer.from(ct).toString('utf8')).not.toContain(secret);
    expect(vault.decryptString(ct)).toBe(secret);
  });

  it('fails closed when the vault is unavailable', () => {
    const ss = mockSafeStorage(false);
    const vault = new SafeStorageVault(ss);
    expect(vault.isEncryptionAvailable()).toBe(false);
    expect(() => vault.encryptString('x')).toThrow(/vault unavailable/i);
    expect(() => vault.decryptString(new Uint8Array([1, 2, 3]))).toThrow(/vault unavailable/i);
  });

  it('fails closed on tamper and on a wrong key', () => {
    const ss = mockSafeStorage();
    const vault = new SafeStorageVault(ss);
    const ct = vault.encryptString('payload');
    const tampered = Uint8Array.from(ct);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => vault.decryptString(tampered)).toThrow();
    // A different master key cannot decrypt.
    const other = new SafeStorageVault(mockSafeStorage());
    expect(() => other.decryptString(ct)).toThrow();
  });
});

describe('FileHostEnrollmentPersistence', () => {
  const base = (hostDeviceId = 'h1'): HostEnrollmentRecord => ({
    version: 1, hostDeviceId, identityCipher: null, scopeKeyCipher: null, signingKeyId: null,
    agreementKeyId: null, fingerprint: null, registered: false, fence: null, leaseExpiresAt: null,
    revocationSeq: 0, controllers: [], sessions: [],
  });

  it('round-trips and writes atomically with mode 0600', () => {
    const f = tmpFile();
    const p = new FileHostEnrollmentPersistence(f);
    expect(p.load()).toBeNull();
    const rec = base();
    rec.identityCipher = 'cipher-blob';
    p.save(rec);
    expect((statSync(f).mode & 0o777)).toBe(0o600);
    expect(p.load()).toEqual(rec);
    // No leftover temp files in the directory.
    expect(existsSync(`${f}.corrupt`)).toBe(false);
  });

  it('quarantines malformed JSON and returns null (recovery)', () => {
    const f = tmpFile();
    writeFileSync(f, '{not json', { mode: 0o600 });
    const p = new FileHostEnrollmentPersistence(f);
    expect(p.load()).toBeNull();
    expect(existsSync(`${f}.corrupt`)).toBe(true);
    // A subsequent save re-initializes cleanly.
    p.save(base('h2'));
    expect(p.load()?.hostDeviceId).toBe('h2');
  });

  it('rejects an out-of-bounds record', () => {
    const f = tmpFile();
    const p = new FileHostEnrollmentPersistence(f, 4 * 1024 * 1024, 2, 2);
    const rec = base();
    rec.controllers = [1, 2, 3].map((n) => ({ controllerDeviceId: `c${n}`, grantId: `g${n}`, keyId: `k${n}`, agreementPublicKey: 'a', transcriptHash: 't', status: 'active' as const }));
    writeFileSync(f, JSON.stringify(rec), { mode: 0o600 });
    expect(p.load()).toBeNull();
    expect(existsSync(`${f}.corrupt`)).toBe(true);
  });
});

describe('ciphertext-at-rest through the real runtime', () => {
  it('persists no private seed or scope key in plaintext', async () => {
    const ss = mockSafeStorage();
    const vault = new SafeStorageVault(ss);
    const f = tmpFile('runtime.json');
    const persistence = new FileHostEnrollmentPersistence(f);
    const accountId = 'acct_cx';
    const hostDeviceId = 'host_cx';
    const stub: ShadowFetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/shadow/enroll/host-identity') return { status: 200, ok: true, text: async () => JSON.stringify({ fingerprint: 'fp', signingKeyId: 'sk', agreementKeyId: 'ak' }) };
      if (path === '/api/shadow/lease') return { status: 200, ok: true, text: async () => JSON.stringify({ fence: { accountId, scopeId: `account:${accountId}`, hostDeviceId, epoch: 1, leaseId: 'lease_cx' }, expiresAt: Date.now() + 120_000 }) };
      return { status: 404, ok: false, text: async () => '{"error":"no"}' };
    };
    const rt = new ShadowHostEnrollmentRuntime({
      vault, persistence,
      session: { get: async () => ({ accountId, hostDeviceId, sessionToken: 'tok', relayOrigin: 'https://relay.test' }) },
      transport: { fetch: stub },
    });
    const status = await rt.start();
    expect(status.state).toBe('running');

    const raw = readFileSync(f, 'utf8');
    const rec = JSON.parse(raw) as HostEnrollmentRecord;
    expect(rec.identityCipher).toBeTruthy();
    expect(rec.scopeKeyCipher).toBeTruthy();
    // Decrypt the identity blob and prove its plaintext seed is NOT in the file.
    const identityJson = JSON.parse(vault.decryptString(Buffer.from(rec.identityCipher!, 'base64url')) as string) as { signingSeed: string; agreementSeed: string };
    expect(raw).not.toContain(identityJson.signingSeed);
    expect(raw).not.toContain(identityJson.agreementSeed);
    // Decrypt the scope key and prove its plaintext is NOT in the file.
    const scopeKeyB64 = vault.decryptString(Buffer.from(rec.scopeKeyCipher!, 'base64url')) as string;
    expect(raw).not.toContain(scopeKeyB64);
    expect(raw).not.toContain('privateKey');
  });
});

describe('expired persisted shadow host lease recovery', () => {
  const accountId = 'acct_expired';
  const hostDeviceId = 'host_expired';
  const relayOrigin = 'https://relay.test';
  const oldFence: Fence = { accountId, scopeId: `account:${accountId}`, hostDeviceId, epoch: 7, leaseId: 'lease_old' };

  function runtimeWith(recordFile: string, vault: SafeStorageVault, fetch: ShadowFetch, now: () => number): ShadowHostEnrollmentRuntime {
    return new ShadowHostEnrollmentRuntime({
      vault,
      persistence: new FileHostEnrollmentPersistence(recordFile),
      session: { get: async () => ({ accountId, hostDeviceId, sessionToken: 'tok', relayOrigin }) },
      transport: { fetch },
      now,
    });
  }

  async function seedRegisteredRecord(recordFile: string, vault: SafeStorageVault, nowMs: number): Promise<HostEnrollmentRecord> {
    const seedFetch: ShadowFetch = async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/shadow/enroll/host-identity') return { status: 200, ok: true, text: async () => JSON.stringify({ fingerprint: 'fp', signingKeyId: 'sk', agreementKeyId: 'ak' }) };
      if (path === '/api/shadow/lease') return { status: 200, ok: true, text: async () => JSON.stringify({ fence: oldFence, expiresAt: nowMs + 120_000 }) };
      return { status: 404, ok: false, text: async () => '{"error":"no"}' };
    };
    await runtimeWith(recordFile, vault, seedFetch, () => nowMs).start();
    const seeded = JSON.parse(readFileSync(recordFile, 'utf8')) as HostEnrollmentRecord;
    seeded.fence = oldFence;
    seeded.leaseExpiresAt = nowMs - 1;
    seeded.controllers = [];
    seeded.sessions = [];
    writeFileSync(recordFile, JSON.stringify(seeded), { mode: 0o600 });
    return seeded;
  }

  async function startWithSeededExpiry(expiry: number | null, controllers: HostEnrollmentRecord['controllers'] = []): Promise<{ rt: ShadowHostEnrollmentRuntime; leaseBodies: Array<Record<string, unknown>>; recordFile: string; nowMs: number }> {
    const nowMs = 1_800_000_000_000;
    const vault = new SafeStorageVault(mockSafeStorage());
    const recordFile = tmpFile('runtime-expiry.json');
    const seeded = await seedRegisteredRecord(recordFile, vault, nowMs);
    seeded.leaseExpiresAt = expiry;
    seeded.controllers = controllers;
    writeFileSync(recordFile, JSON.stringify(seeded), { mode: 0o600 });
    const leaseBodies: Array<Record<string, unknown>> = [];
    const freshFence: Fence = { ...oldFence, epoch: 8, leaseId: 'lease_fresh' };
    const fetch: ShadowFetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/api/shadow/enroll/host-identity') return { status: 200, ok: true, text: async () => JSON.stringify({ fingerprint: 'fp', signingKeyId: 'sk', agreementKeyId: 'ak' }) };
      if (path === '/api/shadow/lease') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        leaseBodies.push(body);
        return { status: 200, ok: true, text: async () => JSON.stringify({ fence: freshFence, expiresAt: nowMs + 240_000 }) };
      }
      return { status: 404, ok: false, text: async () => '{"error":"no"}' };
    };
    return { rt: runtimeWith(recordFile, vault, fetch, () => nowMs), leaseBodies, recordFile, nowMs };
  }

  it('RED: expired registered zero-controller restart requests a fresh lease without stale fence or lease id', async () => {
    const nowMs = 1_800_000_000_000;
    const vault = new SafeStorageVault(mockSafeStorage());
    const f = tmpFile('expired-runtime.json');
    await seedRegisteredRecord(f, vault, nowMs);
    const leaseBodies: Array<Record<string, unknown>> = [];
    const freshFence: Fence = { ...oldFence, epoch: 8, leaseId: 'lease_fresh' };
    const fetch: ShadowFetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/api/shadow/enroll/host-identity') return { status: 200, ok: true, text: async () => JSON.stringify({ fingerprint: 'fp', signingKeyId: 'sk', agreementKeyId: 'ak' }) };
      if (path === '/api/shadow/lease') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        leaseBodies.push(body);
        if (body.currentFence || body.leaseId === oldFence.leaseId) {
          return { status: 409, ok: false, text: async () => '{"error":"expired lease id cannot be reused"}' };
        }
        return { status: 200, ok: true, text: async () => JSON.stringify({ fence: freshFence, expiresAt: nowMs + 240_000 }) };
      }
      return { status: 404, ok: false, text: async () => '{"error":"no"}' };
    };

    await expect(runtimeWith(f, vault, fetch, () => nowMs).start()).resolves.toMatchObject({ state: 'running', epoch: 8 });
    expect(leaseBodies).toHaveLength(1);
    expect(leaseBodies[0]).toMatchObject({ scopeId: `account:${accountId}` });
    expect(leaseBodies[0]).not.toHaveProperty('currentFence');
    expect(leaseBodies[0]).not.toHaveProperty('leaseId');
    const saved = JSON.parse(readFileSync(f, 'utf8')) as HostEnrollmentRecord;
    expect(saved.fence).toEqual(freshFence);
    expect(saved.leaseExpiresAt).toBe(nowMs + 240_000);
    expect(saved.identityCipher).toBeTruthy();
    expect(saved.scopeKeyCipher).toBeTruthy();
  });

  it('unexpired same-host restart still sends exact current fence and lease id', async () => {
    const nowMs = 1_800_000_000_000;
    const vault = new SafeStorageVault(mockSafeStorage());
    const f = tmpFile('unexpired-runtime.json');
    const seeded = await seedRegisteredRecord(f, vault, nowMs);
    seeded.leaseExpiresAt = nowMs + 60_000;
    writeFileSync(f, JSON.stringify(seeded), { mode: 0o600 });
    const leaseBodies: Array<Record<string, unknown>> = [];
    const fetch: ShadowFetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/api/shadow/enroll/host-identity') return { status: 200, ok: true, text: async () => JSON.stringify({ fingerprint: 'fp', signingKeyId: 'sk', agreementKeyId: 'ak' }) };
      if (path === '/api/shadow/lease') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        leaseBodies.push(body);
        if (JSON.stringify(body.currentFence) !== JSON.stringify(oldFence) || body.leaseId !== oldFence.leaseId) {
          return { status: 409, ok: false, text: async () => '{"error":"same host renewal requires current fence proof"}' };
        }
        return { status: 200, ok: true, text: async () => JSON.stringify({ fence: oldFence, expiresAt: nowMs + 180_000 }) };
      }
      return { status: 404, ok: false, text: async () => '{"error":"no"}' };
    };

    await expect(runtimeWith(f, vault, fetch, () => nowMs).start()).resolves.toMatchObject({ state: 'running', epoch: oldFence.epoch });
    expect(leaseBodies[0]).toMatchObject({ scopeId: `account:${accountId}`, currentFence: oldFence, leaseId: oldFence.leaseId });
  });

  it('treats exact-boundary expiry as expired and requests a fresh lease', async () => {
    const { rt, leaseBodies, nowMs } = await startWithSeededExpiry(1_800_000_000_000);
    await expect(rt.start()).resolves.toMatchObject({ state: 'running', epoch: 8 });
    expect(leaseBodies[0]).toEqual({ scopeId: `account:${accountId}` });
    expect(nowMs).toBe(1_800_000_000_000);
  });

  it('treats missing expiry on a persisted fence as invalid and requests a fresh lease only with zero controllers', async () => {
    const { rt, leaseBodies } = await startWithSeededExpiry(null);
    await expect(rt.start()).resolves.toMatchObject({ state: 'running', epoch: 8 });
    expect(leaseBodies[0]).toEqual({ scopeId: `account:${accountId}` });
  });

  it('fails closed instead of refreshing an expired lease when active controllers exist', async () => {
    const controller = { controllerDeviceId: 'ctrl_live', grantId: 'grant_live', keyId: 'key_live', agreementPublicKey: 'a', transcriptHash: 't', status: 'active' as const };
    const { rt, leaseBodies } = await startWithSeededExpiry(1_800_000_000_000 - 1, [controller]);
    await expect(rt.start()).rejects.toMatchObject({ statusCode: 409 });
    await expect(rt.start()).rejects.toThrow(/re-enrollment required/i);
    expect(leaseBodies).toHaveLength(0);
    expect(rt.status()).toMatchObject({ state: 'error' });
    expect(String(rt.status().lastError ?? '')).not.toMatch(/lease_old|grant_live|key_live|ctrl_live/);
  });

  it('does not report an already-running runtime as running after its lease expires', async () => {
    let nowMs = 1_800_000_000_000;
    const vault = new SafeStorageVault(mockSafeStorage());
    const f = tmpFile('running-expiry.json');
    const leaseBodies: Array<Record<string, unknown>> = [];
    const fetch: ShadowFetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/api/shadow/enroll/host-identity') return { status: 200, ok: true, text: async () => JSON.stringify({ fingerprint: 'fp', signingKeyId: 'sk', agreementKeyId: 'ak' }) };
      if (path === '/api/shadow/lease') {
        leaseBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        const first = leaseBodies.length === 1;
        const fence = first ? oldFence : { ...oldFence, epoch: 8, leaseId: 'lease_after_expiry' };
        return { status: 200, ok: true, text: async () => JSON.stringify({ fence, expiresAt: nowMs + 60_000 }) };
      }
      return { status: 404, ok: false, text: async () => '{"error":"no"}' };
    };
    const rt = runtimeWith(f, vault, fetch, () => nowMs);
    await expect(rt.start()).resolves.toMatchObject({ state: 'running', epoch: 7 });
    nowMs += 60_000;
    await expect(rt.start()).resolves.toMatchObject({ state: 'running', epoch: 8 });
    expect(leaseBodies).toHaveLength(2);
    expect(leaseBodies[1]).toEqual({ scopeId: `account:${accountId}` });
  });
});
