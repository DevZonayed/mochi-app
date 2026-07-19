/**
 * Mobile enrollment runtime state-machine unit tests (no server): strict QR
 * parse + legal transitions + fail-closed, driven by a scripted stub transport.
 * The full crypto happy path (grant verify + scope-key unwrap) is proven in the
 * cross-tier E2E and the noble KAT; here we assert the state machine + guards.
 */
import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode } from '@maestro/realtime/shadowCrypto';
import { generateShadowIdentity, createEnrollmentSession, encodeEnrollmentBootstrap } from '@maestro/realtime/shadowEnrollment';
import type { ShadowFetch } from '@maestro/realtime/shadowRequestClient';
import { ShadowMobileEnrollmentRuntime, type SecureStoreAdapter, type EnrollmentMetaStore, type StoredGrantMeta } from './shadowEnrollmentClient';

const ORIGIN = 'https://relay.test';
const ACCOUNT = 'acct_unit';

class MemSecureStore implements SecureStoreAdapter {
  readonly m = new Map<string, string>();
  async getItemAsync(k: string) { return this.m.get(k) ?? null; }
  async setItemAsync(k: string, v: string) { this.m.set(k, v); }
  async deleteItemAsync(k: string) { this.m.delete(k); }
}
class MemMeta implements EnrollmentMetaStore {
  g: StoredGrantMeta | null = null;
  async loadGrant() { return this.g; }
  async saveGrant(m: StoredGrantMeta) { this.g = m; }
  async clearGrant() { this.g = null; }
}

function scriptedFetch(routes: Record<string, { status: number; body: unknown }>): ShadowFetch {
  return async (url) => {
    const path = new URL(url).pathname;
    const r = routes[path] ?? { status: 404, body: { error: 'no route' } };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => JSON.stringify(r.body) };
  };
}

async function makeQr(nowMs: number, ttlMs = 120_000): Promise<string> {
  const host = await generateShadowIdentity(backend, 'host_unit');
  const created = await createEnrollmentSession(backend, { host, accountId: ACCOUNT, relayOrigin: ORIGIN, nowMs, ttlMs, serverPepper: new TextEncoder().encode('p') });
  return encodeEnrollmentBootstrap(created.bootstrap);
}

function runtime(fetch: ShadowFetch, controllerDeviceId = 'ctrl_unit') {
  const secureStore = new MemSecureStore();
  const metaStore = new MemMeta();
  const rt = new ShadowMobileEnrollmentRuntime({
    backend, secureStore, metaStore,
    session: { get: async () => ({ accountId: ACCOUNT, controllerDeviceId, sessionToken: 'tok', relayOrigin: ORIGIN }) },
    transport: { fetch }, allowedOrigins: [ORIGIN], now: () => 1_700_000_000_000,
  });
  return { rt, secureStore, metaStore };
}

describe('mobile enrollment runtime — strict parse', () => {
  it('rejects wrong account', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const { rt } = runtime(scriptedFetch({}));
    // Re-target the session to a different account.
    (rt as unknown as { opts: { session: { get: () => Promise<{ accountId: string; controllerDeviceId: string; sessionToken: string; relayOrigin: string }> } } }).opts.session.get = async () => ({ accountId: 'other', controllerDeviceId: 'c', sessionToken: 't', relayOrigin: ORIGIN });
    expect(await rt.parseBootstrap(qr)).toEqual({ ok: false, reason: 'wrong-account' });
    expect(rt.getState()).toBe('error');
  });

  it('rejects an origin not in the allowlist', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const secureStore = new MemSecureStore();
    const rt = new ShadowMobileEnrollmentRuntime({
      backend, secureStore, metaStore: new MemMeta(),
      session: { get: async () => ({ accountId: ACCOUNT, controllerDeviceId: 'c', sessionToken: 't', relayOrigin: ORIGIN }) },
      transport: { fetch: scriptedFetch({}) }, allowedOrigins: ['https://evil.test'], now: () => 1_700_000_000_000,
    });
    expect(await rt.parseBootstrap(qr)).toEqual({ ok: false, reason: 'origin-not-allowed' });
  });

  it('rejects an expired bootstrap', async () => {
    const qr = await makeQr(1_700_000_000_000, 1_000);
    const { rt } = runtime(scriptedFetch({}));
    // now() is fixed at issue+... make it far in the future by rebuilding runtime with a later clock.
    const late = new ShadowMobileEnrollmentRuntime({
      backend, secureStore: new MemSecureStore(), metaStore: new MemMeta(),
      session: { get: async () => ({ accountId: ACCOUNT, controllerDeviceId: 'c', sessionToken: 't', relayOrigin: ORIGIN }) },
      transport: { fetch: scriptedFetch({}) }, allowedOrigins: [ORIGIN], now: () => 1_700_000_100_000,
    });
    void rt;
    expect(await late.parseBootstrap(qr)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('mobile enrollment runtime — transitions + guards', () => {
  it('parse → request → awaiting-host, then a denied poll is terminal', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const { rt } = runtime(scriptedFetch({
      '/api/shadow/enroll/request': { status: 200, body: { sessionId: 'es', controllerDeviceId: 'ctrl_unit', status: 'pending' } },
      '/api/shadow/enroll/poll': { status: 200, body: { status: 'denied' } },
    }));
    expect((await rt.parseBootstrap(qr)).ok).toBe(true);
    expect(rt.getState()).toBe('confirming');
    expect((await rt.requestEnrollment()).ok).toBe(true);
    expect(rt.getState()).toBe('awaiting-host');
    expect(rt.canIssueCommand()).toBe(false);
    expect(await rt.poll()).toBe('denied');
    expect(rt.canIssueCommand()).toBe(false);
  });

  it('a request rejected by the relay lands in error, not awaiting', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const { rt } = runtime(scriptedFetch({
      '/api/shadow/enroll/request': { status: 403, body: { error: 'enrollment denied' } },
    }));
    expect((await rt.parseBootstrap(qr)).ok).toBe(true);
    const res = await rt.requestEnrollment();
    expect(res.ok).toBe(false);
    expect(rt.getState()).toBe('error');
  });

  it('markRevoked is sticky and reports read-only truth', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const { rt } = runtime(scriptedFetch({
      '/api/shadow/enroll/request': { status: 200, body: { sessionId: 'es', controllerDeviceId: 'ctrl_unit', status: 'pending' } },
    }));
    await rt.parseBootstrap(qr);
    await rt.requestEnrollment();
    await rt.markRevoked();
    expect(rt.getState()).toBe('revoked');
    expect(rt.status().readonlyReason).toBe('revoked');
    expect(rt.canIssueCommand()).toBe(false);
  });
});
