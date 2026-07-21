import { describe, it, expect } from 'vitest';
import { createMemoryShadowStore, type ShadowExpectedAuthority } from './shadowClient';
import { ShadowControllerService } from './shadowControllerService';

const expectedAuthority: ShadowExpectedAuthority = {
  fence: { accountId: 'acct', scopeId: 'scope', hostDeviceId: 'host', epoch: 43, leaseId: 'lease_43' },
  controllerDeviceId: 'ctrl',
  leaseExpiresAt: 5_000_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeService() {
  const service = new ShadowControllerService({
    backend: {
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      sha256: async (bytes: Uint8Array) => bytes,
      hkdfSha256: async () => new Uint8Array(32),
      sign: async () => new Uint8Array([1]),
      verify: async () => true,
      deriveSharedSecret: async () => new Uint8Array(32),
      encrypt: async () => ({ iv: new Uint8Array(12), ciphertext: new Uint8Array(0), tag: new Uint8Array(16) }),
      decrypt: async () => new Uint8Array(0),
    } as any,
    store: createMemoryShadowStore('ctrl', 'host', expectedAuthority),
    scopeKey: new Uint8Array(32).fill(9),
    scopeKeyId: 'sk1',
    expectedAuthority,
    hostSigningPublicKey: new Uint8Array([1, 2, 3]),
    hostSigningKeyId: 'host-key',
    controllerSigner: { keyId: 'ctrl-key', sign: async () => new Uint8Array([1]) },
    session: async () => ({ accountId: 'acct', controllerDeviceId: 'ctrl', sessionToken: 'tok', relayOrigin: 'https://api.test' }),
    transport: { fetch: async () => { throw new Error('unused'); } },
    now: () => 1_000,
  });
  return service as ShadowControllerService & { [k: string]: any };
}

describe('ShadowControllerService initial drain and sync notifications', () => {
  it('serializes overlapping connect() and tick() through one load-drain-apply seam with stable-head completion', async () => {
    const svc = makeService();
    const connectGate = deferred<{ ok: true; status: number; json: { decision: { decision: 'delta'; fromSeq: number; toSeq: number }; events: Array<{ seq: number }> } }>();
    let loadCalls = 0;
    let ackCalls = 0;
    let authorityCalls = 0;
    const connectCalls: number[] = [];
    const appliedSeqs: number[] = [];
    const cursorPosts: number[] = [];
    const notifications: Array<{ online: boolean; lastSeq: number | null }> = [];
    let lastSeq = 0;
    let online = false;

    svc.onProjectionChange(() => {
      const status = svc.status();
      notifications.push({ online: status.online, lastSeq: status.lastSeq });
    });

    (svc as any).client = {
      load: async () => { loadCalls += 1; },
      read: () => ({
        cursor: lastSeq > 0 ? { lastSeq, lastEventId: `e${lastSeq}`, lastDigest: `d${lastSeq}` } : null,
        connection: online ? 'online' : 'offline',
        entities: appliedSeqs.map((seq) => ({ seq })),
        commands: [],
      }),
      applyWire: async (wire: { seq: number }) => {
        if (!appliedSeqs.includes(wire.seq)) appliedSeqs.push(wire.seq);
        lastSeq = Math.max(lastSeq, wire.seq);
        return { status: 'applied' };
      },
      setOnline: async (value: boolean) => { online = value; },
    };
    (svc as any).pollAcks = async () => { ackCalls += 1; };
    (svc as any).request = async (_method: string, path: string, body?: { hello?: { lastSeq: number } }) => {
      if (path.startsWith('/api/shadow/transitions')) return { ok: true, status: 200, json: { grants: [] } };
      if (path.startsWith('/api/shadow/authority')) {
        authorityCalls += 1;
        return { ok: true, status: 200, json: { fence: expectedAuthority.fence, expiresAt: 10_000 } };
      }
      if (path === '/api/shadow/connect') {
        const seen = body?.hello?.lastSeq ?? 0;
        connectCalls.push(seen);
        if (seen === 0) return connectGate.promise;
        if (seen === 500) {
          return {
            ok: true,
            status: 200,
            json: {
              decision: { decision: 'delta', fromSeq: 500, toSeq: 752 },
              events: Array.from({ length: 252 }, (_, i) => ({ seq: 501 + i })),
            },
          };
        }
      }
      if (path === '/api/shadow/cursor') {
        cursorPosts.push((body as { lastSeq: number }).lastSeq);
        return { ok: true, status: 200, json: { ok: true } };
      }
      if (path.startsWith('/api/shadow/commands/acks')) return { ok: true, status: 200, json: { acks: [] } };
      throw new Error(`unexpected ${path}`);
    };

    const connectPromise = svc.connect();
    const tickPromise = (svc as any).tick();
    connectGate.resolve({
      ok: true,
      status: 200,
      json: {
        decision: { decision: 'delta', fromSeq: 0, toSeq: 752 },
        events: Array.from({ length: 500 }, (_, i) => ({ seq: i + 1 })),
      },
    });
    const [applied] = await Promise.all([connectPromise, tickPromise]);
    await Promise.resolve();
    await Promise.resolve();

    expect(applied).toBe(752);
    expect(loadCalls).toBe(1);
    expect(authorityCalls).toBe(1);
    expect(ackCalls).toBe(1);
    expect(connectCalls).toEqual([0, 500]);
    expect(cursorPosts).toEqual([500, 752]);
    expect(appliedSeqs).toHaveLength(752);
    expect(appliedSeqs[0]).toBe(1);
    expect(appliedSeqs[751]).toBe(752);
    expect(new Set(appliedSeqs).size).toBe(752);
    expect(svc.status().online).toBe(true);
    expect(svc.status().lastSeq).toBe(752);
    expect(notifications.some((entry) => entry.lastSeq === 500 && entry.online === false)).toBe(true);
    expect(notifications.some((entry) => entry.lastSeq === 752 && entry.online === true)).toBe(true);
  });

  it('tick stays offline when the baseline cannot reach head and does not regress lastSeq', async () => {
    const svc = makeService();
    let lastSeq = 10;
    let online = false;
    let notifications = 0;
    const appliedSeqs: number[] = [];
    svc.onProjectionChange(() => { notifications += 1; });
    (svc as any).client = {
      load: async () => {},
      read: () => ({
        cursor: { lastSeq, lastEventId: `e${lastSeq}`, lastDigest: `d${lastSeq}` },
        connection: online ? 'online' : 'offline',
        entities: appliedSeqs.map((seq) => ({ seq })),
        commands: [],
      }),
      applyWire: async (wire: { seq: number }) => {
        appliedSeqs.push(wire.seq);
        lastSeq = Math.max(lastSeq, wire.seq);
        return { status: 'applied' };
      },
      setOnline: async (value: boolean) => { online = value; },
    };
    (svc as any).pollAcks = async () => {};
    (svc as any).request = async (_method: string, path: string) => {
      if (path.startsWith('/api/shadow/transitions')) return { ok: true, status: 200, json: { grants: [] } };
      if (path.startsWith('/api/shadow/authority')) return { ok: true, status: 200, json: { fence: expectedAuthority.fence, expiresAt: 10_000 } };
      if (path === '/api/shadow/connect') {
        return {
          ok: true,
          status: 200,
          json: {
            decision: { decision: 'delta', fromSeq: 10, toSeq: 99 },
            events: Array.from({ length: 5 }, (_, i) => ({ seq: 11 + i })),
          },
        };
      }
      if (path === '/api/shadow/cursor') return { ok: true, status: 200, json: { ok: true } };
      if (path.startsWith('/api/shadow/commands/acks')) return { ok: true, status: 200, json: { acks: [] } };
      throw new Error(`unexpected ${path}`);
    };

    await (svc as any).tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(svc.status().online).toBe(false);
    expect(svc.status().lastSeq).toBe(15);
    expect(svc.status().lastError).toBe('baseline-drain-incomplete');
    expect(lastSeq).toBeGreaterThanOrEqual(10);
    expect(Math.min(...appliedSeqs)).toBe(11);
    expect(notifications).toBeGreaterThanOrEqual(2);
  });
});
