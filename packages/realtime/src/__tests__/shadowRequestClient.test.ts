import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto } from '../shadowCryptoNode.js';
import { base64urlDecode } from '../shadowCrypto.js';
import {
  ShadowRequestClient,
  ShadowTransportError,
  shadowRequestProofBytes,
  normalizePathQuery,
  SHADOW_REQUEST_HEADERS,
  type ShadowFetch,
  type ShadowSession,
  type ShadowRequestSigner,
} from '../shadowRequestClient.js';

const backend = nodeShadowCrypto;

const session: ShadowSession = {
  accountId: 'acct_1',
  deviceId: 'host_1',
  sessionToken: 'sess-token-abc',
};

async function makeSigner(): Promise<{ signer: ShadowRequestSigner; publicKey: Uint8Array }> {
  const kp = await backend.generateSigningKeyPair();
  return {
    publicKey: kp.publicKey,
    signer: {
      keyId: 'sk_test',
      sign: (bytes) => backend.sign(kp.privateKey, bytes),
    },
  };
}

/** A fetch that records the last request and returns a canned JSON response. */
function recordingFetch(response: { status: number; body: string }): {
  fetch: ShadowFetch;
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: ShadowFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text: async () => response.body,
    };
  };
  return { fetch, calls };
}

describe('normalizePathQuery', () => {
  it('keeps pathname and sorts query params by key then value', () => {
    expect(normalizePathQuery('/api/shadow/x?b=2&a=1')).toBe('/api/shadow/x?a=1&b=2');
    expect(normalizePathQuery('/api/shadow/x')).toBe('/api/shadow/x');
    // reordering does not change the normalized form
    expect(normalizePathQuery('/p?z=9&z=1')).toBe(normalizePathQuery('/p?z=1&z=9'));
  });
});

describe('shadowRequestProofBytes', () => {
  it('is deterministic and body/method/path sensitive', async () => {
    const base = {
      method: 'POST',
      rawUrl: '/api/shadow/events',
      rawBody: '{"a":1}',
      accountId: 'acct_1',
      deviceId: 'host_1',
      keyId: 'sk_test',
      timestampMs: 1_700_000_000_000,
      nonce: 'nonce1',
    };
    const a = await shadowRequestProofBytes(backend, base);
    const b = await shadowRequestProofBytes(backend, base);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const diffBody = await shadowRequestProofBytes(backend, { ...base, rawBody: '{"a":2}' });
    expect(Buffer.from(a).equals(Buffer.from(diffBody))).toBe(false);
    const diffMethod = await shadowRequestProofBytes(backend, { ...base, method: 'GET' });
    expect(Buffer.from(a).equals(Buffer.from(diffMethod))).toBe(false);
  });
});

describe('ShadowRequestClient origin allowlist', () => {
  const common = { fetch: recordingFetch({ status: 200, body: '{}' }).fetch, backend, now: () => 1 };
  it('accepts https', () => {
    expect(() => new ShadowRequestClient({ ...common, baseUrl: 'https://api.example.com' })).not.toThrow();
  });
  it('rejects http non-loopback even with the loopback flag', () => {
    expect(() => new ShadowRequestClient({ ...common, baseUrl: 'http://api.example.com', allowInsecureLoopback: true }))
      .toThrowError(ShadowTransportError);
  });
  it('rejects http loopback without the flag', () => {
    expect(() => new ShadowRequestClient({ ...common, baseUrl: 'http://127.0.0.1:8080' }))
      .toThrowError(ShadowTransportError);
  });
  it('accepts http loopback only with the flag', () => {
    expect(() => new ShadowRequestClient({ ...common, baseUrl: 'http://127.0.0.1:8080', allowInsecureLoopback: true }))
      .not.toThrow();
  });
});

describe('ShadowRequestClient.requestEnrolled', () => {
  it('produces a valid Ed25519 proof the server backend verifies', async () => {
    const { signer, publicKey } = await makeSigner();
    const rec = recordingFetch({ status: 200, body: '{"ok":true}' });
    const client = new ShadowRequestClient({
      baseUrl: 'http://127.0.0.1:9999',
      allowInsecureLoopback: true,
      fetch: rec.fetch,
      backend,
      now: () => 1_700_000_000_000,
      randomNonce: () => 'fixed-nonce',
    });
    const res = await client.requestEnrolled(session, signer, {
      method: 'POST',
      path: '/api/shadow/events',
      body: { events: [] },
    });
    expect(res.ok).toBe(true);
    expect(res.json).toEqual({ ok: true });
    const call = rec.calls[0]!;
    expect(call.headers[SHADOW_REQUEST_HEADERS.device]).toBe('host_1');
    expect(call.headers[SHADOW_REQUEST_HEADERS.keyId]).toBe('sk_test');
    expect(call.headers[SHADOW_REQUEST_HEADERS.timestamp]).toBe('1700000000000');
    expect(call.headers[SHADOW_REQUEST_HEADERS.nonce]).toBe('fixed-nonce');
    expect(call.headers.authorization).toBe('Bearer sess-token-abc');
    // Re-derive the exact signed bytes and verify the signature.
    const proof = await shadowRequestProofBytes(backend, {
      method: 'POST',
      rawUrl: '/api/shadow/events',
      rawBody: JSON.stringify({ events: [] }),
      accountId: 'acct_1',
      deviceId: 'host_1',
      keyId: 'sk_test',
      timestampMs: 1_700_000_000_000,
      nonce: 'fixed-nonce',
    });
    const sig = base64urlDecode(call.headers[SHADOW_REQUEST_HEADERS.signature]!);
    expect(await backend.verify(publicKey, proof, sig)).toBe(true);
  });

  it('generates a fresh nonce and signature on every attempt', async () => {
    const { signer } = await makeSigner();
    const rec = recordingFetch({ status: 200, body: '{}' });
    const client = new ShadowRequestClient({
      baseUrl: 'https://relay.example.com',
      fetch: rec.fetch,
      backend,
      now: () => 5,
    });
    await client.requestEnrolled(session, signer, { method: 'POST', path: '/api/shadow/lease', body: {} });
    await client.requestEnrolled(session, signer, { method: 'POST', path: '/api/shadow/lease', body: {} });
    const n1 = rec.calls[0]!.headers[SHADOW_REQUEST_HEADERS.nonce];
    const n2 = rec.calls[1]!.headers[SHADOW_REQUEST_HEADERS.nonce];
    expect(n1).not.toBe(n2);
    const s1 = rec.calls[0]!.headers[SHADOW_REQUEST_HEADERS.signature];
    const s2 = rec.calls[1]!.headers[SHADOW_REQUEST_HEADERS.signature];
    expect(s1).not.toBe(s2);
  });
});

describe('ShadowRequestClient.requestBootstrap', () => {
  it('sends the session bearer without proof headers', async () => {
    const rec = recordingFetch({ status: 200, body: '{"sessionId":"es_1"}' });
    const client = new ShadowRequestClient({ baseUrl: 'https://relay.example.com', fetch: rec.fetch, backend, now: () => 1 });
    await client.requestBootstrap(session, { method: 'POST', path: '/api/shadow/enroll/request', body: { x: 1 }, includeDeviceId: false });
    const call = rec.calls[0]!;
    expect(call.headers.authorization).toBe('Bearer sess-token-abc');
    expect(call.headers[SHADOW_REQUEST_HEADERS.signature]).toBeUndefined();
    expect(call.headers[SHADOW_REQUEST_HEADERS.device]).toBeUndefined();
  });
});

describe('ShadowRequestClient error mapping', () => {
  it('maps a timeout to a bounded ShadowTransportError', async () => {
    const hangingFetch: ShadowFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = new ShadowRequestClient({
      baseUrl: 'https://relay.example.com',
      fetch: hangingFetch,
      backend,
      now: () => 1,
      timeoutMs: 20,
    });
    await expect(client.requestBootstrap(session, { method: 'GET', path: '/api/shadow/enroll/sessions' }))
      .rejects.toMatchObject({ kind: 'timeout' });
  });

  it('rejects an oversized response', async () => {
    const big = 'x'.repeat(100);
    const rec = recordingFetch({ status: 200, body: big });
    const client = new ShadowRequestClient({
      baseUrl: 'https://relay.example.com',
      fetch: rec.fetch,
      backend,
      now: () => 1,
      maxResponseBytes: 10,
    });
    await expect(client.requestBootstrap(session, { method: 'GET', path: '/api/x' }))
      .rejects.toMatchObject({ kind: 'too-large' });
  });

  it('surfaces server { error } on non-2xx without throwing', async () => {
    const rec = recordingFetch({ status: 401, body: '{"error":"shadow proof stale"}' });
    const client = new ShadowRequestClient({ baseUrl: 'https://relay.example.com', fetch: rec.fetch, backend, now: () => 1 });
    const res = await client.requestBootstrap(session, { method: 'GET', path: '/api/x' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toBe('shadow proof stale');
  });
});
