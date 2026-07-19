/**
 * Mobile enrollment runtime state-machine unit tests (no server): strict QR
 * parse + legal transitions + fail-closed, driven by a scripted stub transport.
 * The full crypto happy path (grant verify + scope-key unwrap) is proven in the
 * cross-tier E2E and the noble KAT; here we assert the state machine + guards.
 */
import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode } from '@maestro/realtime/shadowCrypto';
import { generateShadowIdentity, createEnrollmentSession, encodeEnrollmentBootstrap, verifyEnrollmentRequest } from '@maestro/realtime/shadowEnrollment';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
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

function scriptedFetchWithCapture(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Array<{ path: string; headers: Record<string, string>; body: unknown }> = [];
  const fetch: ShadowFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const r = routes[path] ?? { status: 404, body: { error: 'no route' } };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

async function makeQr(nowMs: number, ttlMs = 120_000): Promise<string> {
  const host = await generateShadowIdentity(backend, 'host_unit');
  const created = await createEnrollmentSession(backend, { host, accountId: ACCOUNT, relayOrigin: ORIGIN, nowMs, ttlMs, serverPepper: new TextEncoder().encode('p') });
  return encodeEnrollmentBootstrap(created.bootstrap);
}

async function makeBootstrap(nowMs: number, ttlMs = 120_000) {
  const host = await generateShadowIdentity(backend, 'host_unit');
  const created = await createEnrollmentSession(backend, { host, accountId: ACCOUNT, relayOrigin: ORIGIN, nowMs, ttlMs, serverPepper: new TextEncoder().encode('p') });
  return created.bootstrap;
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

async function storeIdentityBlob(store: MemSecureStore, deviceId: string, blob: unknown): Promise<void> {
  await store.setItemAsync(`maestro.shadow.identity.${deviceId}`, JSON.stringify(blob));
}

async function staleSigningIdentityBlob() {
  const signing = await backend.generateSigningKeyPair();
  const otherSigning = await backend.generateSigningKeyPair();
  const agreement = await backend.generateAgreementKeyPair();
  return {
    v: 1,
    signingSeed: base64urlEncode(signing.privateKey),
    signingPub: base64urlEncode(otherSigning.publicKey),
    agreementSeed: base64urlEncode(agreement.privateKey),
    agreementPub: base64urlEncode(agreement.publicKey),
  };
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

  it('physical seam: bootstrap succeeds, request POST rejects before persistence, and safe status remains visible', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const { fetch, calls } = scriptedFetchWithCapture({
      '/api/shadow/enroll/request': { status: 401, body: { error: 'Unauthorized — sign in to your Maestro account', code: 'unauthorized' } },
    });
    const { rt } = runtime(fetch);
    expect((await rt.parseBootstrap(qr)).ok).toBe(true);
    const res = await rt.requestEnrollment();
    expect(res).toEqual({ ok: false, reason: 'Enrollment request rejected (401): sign in again' });
    expect(rt.getState()).toBe('error');
    expect(rt.status().lastError).toBe('Enrollment request rejected (401): sign in again');
    const submit = calls.find((c) => c.path === '/api/shadow/enroll/request');
    expect(submit?.headers.authorization).toBe('Bearer tok');
    expect(res.ok ? '' : res.reason).not.toMatch(/presentedSecret|signature|privateKey|tok[A-Za-z0-9_-]/);
  });

  it('maps only exact known server codes to hardcoded local enrollment messages', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const { rt } = runtime(scriptedFetch({
      '/api/shadow/enroll/request': { status: 400, body: { error: 'unexpected relay text', code: 'bad_controller_device_id' } },
    }));
    expect((await rt.parseBootstrap(qr)).ok).toBe(true);
    const res = await rt.requestEnrollment();
    expect(res).toEqual({ ok: false, reason: 'Enrollment request rejected (400): invalid device identity' });
    expect(rt.status().lastError).toBe('Enrollment request rejected (400): invalid device identity');
  });

  it('collapses unknown and malicious server code values to local status fallback', async () => {
    const cases = [
      { code: 'sk_live_regex_safe_secret', error: 'unknown safe words', status: 401, expected: 'Enrollment request rejected (401): sign in again' },
      { code: 'unauthorized.', error: 'unknown safe words', status: 401, expected: 'Enrollment request rejected (401): sign in again' },
      { code: 'bad_controller_device_id ', error: 'unknown safe words', status: 400, expected: 'Enrollment request rejected (400): invalid request' },
      { code: 'bad-controller-device-id', error: 'unknown safe words', status: 400, expected: 'Enrollment request rejected (400): invalid request' },
      { code: 'a'.repeat(512), error: 'unknown safe words', status: 403, expected: 'Enrollment request rejected (403): request failed' },
      { code: 'host_offline/token_abc123secret', error: 'unknown safe words', status: 409, expected: 'Enrollment request rejected (409): request conflict' },
    ] as const;
    for (const c of cases) {
      const qr = await makeQr(1_700_000_000_000);
      const { rt } = runtime(scriptedFetch({
        '/api/shadow/enroll/request': { status: c.status, body: { error: c.error, code: c.code } },
      }), `ctrl_${base64urlEncode(backend.randomBytes(8))}`);
      expect((await rt.parseBootstrap(qr)).ok).toBe(true);
      const res = await rt.requestEnrollment();
      expect(res).toEqual({ ok: false, reason: c.expected });
      expect(rt.status().lastError).toBe(c.expected);
      expect(res.ok ? '' : res.reason).not.toContain(c.code);
      expect(rt.status().lastError ?? '').not.toContain(c.error);
    }
  });

  it('does not display regex-safe secret-like server details from account enrollment failures', async () => {
    const { rt } = runtime(scriptedFetch({
      '/api/shadow/enroll/account/macs': { status: 503, body: { error: 'token abc123 secret', code: 'sk_live_regex_safe_secret' } },
    }));
    const res = await rt.listAccountMacs();
    expect(res).toEqual({ ok: false, reason: 'Mac list rejected (503): request failed' });
    expect(res.ok ? '' : res.reason).not.toMatch(/abc123|sk_live|secret/);
  });

  it('physical seam: transport failure maps to a bounded network category', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const fetch: ShadowFetch = async () => { throw new TypeError('Network request failed'); };
    const { rt } = runtime(fetch);
    expect((await rt.parseBootstrap(qr)).ok).toBe(true);
    expect(await rt.requestEnrollment()).toEqual({ ok: false, reason: 'Network request failed' });
    expect(rt.status().lastError).toBe('Network request failed');
  });

  it('repairs a never-enrolled persisted identity whose private key no longer matches its public key before submit', async () => {
    const bootstrap = await makeBootstrap(1_700_000_000_000);
    const qr = encodeEnrollmentBootstrap(bootstrap);
    const requestedCapabilities: ShadowCapability[] = ['account.read', 'session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set', 'screen.view'];
    const calls: Array<{ request: { controllerDeviceId: string; signingPublicKey: string; signature: string } }> = [];
    const fetch: ShadowFetch = async (_url, init) => {
      const body = JSON.parse(init.body ?? '{}') as { request: { controllerDeviceId: string; signingPublicKey: string; signature: string } };
      calls.push({ request: body.request });
      const verified = await verifyEnrollmentRequest(backend, { request: body.request as never, bootstrap, expectedAccountId: ACCOUNT, nowMs: 1_700_000_000_000 });
      return verified.ok
        ? { status: 200, ok: true, text: async () => JSON.stringify({ sessionId: bootstrap.sessionId, controllerDeviceId: body.request.controllerDeviceId, status: 'pending' }) }
        : { status: 403, ok: false, text: async () => JSON.stringify({ error: 'enrollment denied' }) };
    };
    const { rt, secureStore } = runtime(fetch, '979459b5-controller');
    await storeIdentityBlob(secureStore, '979459b5-controller', await staleSigningIdentityBlob());
    expect((await rt.parseBootstrap(qr)).ok).toBe(true);
    expect(rt.setRequestedCapabilities(requestedCapabilities)).toBe(true);
    expect(await rt.requestEnrollment()).toEqual({ ok: true });
    expect(rt.getState()).toBe('awaiting-host');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.controllerDeviceId).toBe('979459b5-controller');
    const persisted = JSON.parse((await secureStore.getItemAsync('maestro.shadow.identity.979459b5-controller')) ?? '{}') as { v?: number };
    expect(persisted.v).toBe(1);
  });

  it('does not silently rotate an unsupported identity when an active grant exists', async () => {
    const qr = await makeQr(1_700_000_000_000);
    const { rt, secureStore, metaStore } = runtime(scriptedFetch({}), 'ctrl_with_grant');
    metaStore.g = {
      sessionId: 'es_existing',
      controllerDeviceId: 'ctrl_with_grant',
      grantId: 'grant_existing',
      keyId: 'wk_existing',
      scopeKeyId: 'wk_existing',
      fence: { accountId: ACCOUNT, scopeId: `account:${ACCOUNT}`, hostDeviceId: 'host_existing', epoch: 1, leaseId: 'lease_existing' },
      expiresAt: 1_800_000_000_000,
      transcriptHash: base64urlEncode(backend.randomBytes(32)),
      hostSigningKeyId: 'sk_existing',
      hostSigningPublicKey: base64urlEncode(backend.randomBytes(32)),
      leaseExpiresAt: 1_800_000_000_000,
      status: 'active',
    };
    await storeIdentityBlob(secureStore, 'ctrl_with_grant', await staleSigningIdentityBlob());
    expect((await rt.parseBootstrap(qr)).ok).toBe(true);
    expect(await rt.requestEnrollment()).toEqual({ ok: false, reason: 'Enrollment identity needs repair; reconnect this device' });
    expect(await secureStore.getItemAsync('maestro.shadow.identity.ctrl_with_grant')).not.toBeNull();
  });

  it('lists account Macs and starts enrollment from a server challenge without QR', async () => {
    const host = await generateShadowIdentity(backend, 'host_account');
    const challenge = await createEnrollmentSession(backend, { host, accountId: ACCOUNT, relayOrigin: ORIGIN, nowMs: 1_700_000_000_000, ttlMs: 120_000, serverPepper: new TextEncoder().encode('p') });
    const { fetch, calls } = scriptedFetchWithCapture({
      '/api/shadow/enroll/account/macs': { status: 200, body: { macs: [{ hostDeviceId: host.deviceId, name: 'Mac', platform: 'macos', fingerprint: host.signingKeyId, online: true, lastSeen: 1, leaseExpiresAt: 2 }] } },
      '/api/shadow/enroll/account/challenge': { status: 200, body: { bootstrap: challenge.bootstrap } },
      '/api/shadow/enroll/request': { status: 200, body: { sessionId: challenge.bootstrap.sessionId, controllerDeviceId: 'ctrl_unit', status: 'pending' } },
    });
    const { rt } = runtime(fetch);
    const listed = await rt.listAccountMacs();
    expect(listed.ok && listed.macs[0]?.hostDeviceId).toBe(host.deviceId);
    expect((await rt.startAccountEnrollment(host.deviceId)).ok).toBe(true);
    expect(rt.getState()).toBe('confirming');
    expect((await rt.requestEnrollment()).ok).toBe(true);
    expect(rt.getState()).toBe('awaiting-host');
    const requestBody = calls.find((c) => c.path === '/api/shadow/enroll/request')?.body as { request?: { nonce?: string }; idempotencyKey?: string } | undefined;
    expect(requestBody).toMatchObject({ idempotencyKey: expect.stringMatching(/^idem_[A-Za-z0-9_-]+$/) });
    expect(requestBody?.idempotencyKey).toBe(`idem_${requestBody?.request?.nonce}`);
  });

  it('account enrollment challenge errors are explicit and do not fall through to awaiting-host', async () => {
    const { rt } = runtime(scriptedFetch({
      '/api/shadow/enroll/account/challenge': { status: 409, body: { error: 'host offline' } },
    }));
    const res = await rt.startAccountEnrollment('host_offline');
    expect(res).toEqual({ ok: false, reason: 'Mac enrollment rejected (409): host offline' });
    expect(rt.getState()).toBe('error');
    expect(rt.status().lastError).toBe('Mac enrollment rejected (409): host offline');
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
