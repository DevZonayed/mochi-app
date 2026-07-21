/**
 * Permanent reproduction of the independent reviewer's HIGH finding
 * (job e4de6abc): "ShadowHostCore is not reached from the production WebKit
 * sidecar". This test PINS the correction — the production sidecar bootstrap now
 * reaches `ShadowHostCore` through the enrollment runtime + data service — and a
 * runtime check proves the composed service drives a real `ShadowHostCore`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { decodeShadowMessage } from '@maestro/realtime';
import { ShadowHostCore, StaticShadowKeyProvider } from './shadow-host.ts';
import { ShadowHostDataService, defineShadowCommandRegistry } from './shadow-host-service.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeDataService(input?: {
  keyId?: string;
  relay?: (events: Array<{ seq: number }>, init: RequestInit) => Promise<Response> | Response;
  now?: () => number;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'dp-svc-'));
  const keyId = input?.keyId ?? 'wk_svc';
  const scopeKey = Buffer.alloc(32, 7);
  const keys = new StaticShadowKeyProvider(keyId, scopeKey);
  const core = new ShadowHostCore(join(dir, 'shadow'), keys);
  const fence = { accountId: 'a', scopeId: 'account:a', hostDeviceId: 'h', epoch: 1, leaseId: 'l' };
  const svc = new ShadowHostDataService({
    host: core, keys, scopeKeyId: keyId, fence, leaseExpiresAt: Date.now() + 60_000,
    now: input?.now,
    session: async () => ({ accountId: 'a', hostDeviceId: 'h', sessionToken: 't', relayOrigin: 'http://127.0.0.1:1' }),
    signer: { keyId: 'sk', sign: async () => new Uint8Array(64) },
    transport: {
      fetch: async (_url, init) => {
        const events = init.body ? (JSON.parse(init.body.toString()).events ?? []) as Array<{ seq: number }> : [];
        return input?.relay ? input.relay(events, init) : { status: 200, ok: true, text: async () => JSON.stringify({ accepted: events.length, headSeq: events.at(-1)?.seq ?? 0 }) };
      },
      allowInsecureLoopback: true,
    },
    commandRegistry: defineShadowCommandRegistry({}),
  });
  return { svc, core };
}

function appendProjects(svc: ShadowHostDataService, count: number): void {
  for (let i = 1; i <= count; i++) {
    svc.appendEvent({ collection: 'project', op: 'upsert', entityId: `p_${i}`, revision: 1, payload: { n: i } });
  }
}

function countUnpublished(sqlitePath: string): number {
  const db = new Database(sqlitePath, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM events WHERE published=0').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('production wiring: sidecar reaches ShadowHostCore (reviewer finding fixed)', () => {
  it('headless-main constructs the data/command service and routes the shadowHostData surface', () => {
    const headless = read('../sidecar/src/headless-main.ts');
    expect(headless).toContain('ShadowHostDataService');
    // Phase 3A2b1 Section B: the production path now builds the FULL data plane
    // (service + all-project projection) via buildDataPlane and wires the Store hook.
    expect(headless).toContain('buildDataPlane');
    expect(headless).toContain('ShadowProductProjection');
    expect(headless).toContain('store.onDurableChange');
    expect(headless).toContain("method.startsWith('shadowHostData')");
    expect(headless).toContain('pollAndExecuteCommands');
    expect(headless).toContain('startShadowHostDataLoop');
  });

  it('the data service module and the enrollment runtime both reach ShadowHostCore', () => {
    expect(read('shadow-host-service.ts')).toContain('ShadowHostCore');
    const runtime = read('shadow-enrollment-host.ts');
    expect(runtime).toContain('ShadowHostCore');
    expect(runtime).toContain('buildDataService');
    // Section B: the runtime exposes buildDataPlane co-constructing the projection.
    expect(runtime).toContain('buildDataPlane');
    expect(runtime).toContain('ShadowProductProjection');
    // The projection + data service SHARE one host (single durable journal/index).
    expect(runtime).toContain('buildHostAndService');
  });

  it('the command registry forbids constructing a mutating/non-idempotent entry', () => {
    // read-only + event-only are accepted…
    expect(() => defineShadowCommandRegistry({
      a: { effectMode: 'read-only', execute: async () => ({ ok: false, code: 'x', message: 'x' }) },
      b: { effectMode: 'event-only', execute: async () => ({ ok: false, code: 'x', message: 'x' }) },
    })).not.toThrow();
    // …a mutating effect mode cannot be registered (runtime contract; also a type error).
    expect(() => defineShadowCommandRegistry({
      bad: { effectMode: 'mutating' as unknown as 'read-only', execute: async () => ({ ok: false, code: 'x', message: 'x' }) },
    })).toThrow(/forbidden effectMode/);
  });

  it('the composed data service drives a real ShadowHostCore (runtime)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-wire-'));
    const scopeKey = Buffer.alloc(32, 3);
    const keys = new StaticShadowKeyProvider('wk_test', scopeKey);
    const core = new ShadowHostCore(join(dir, 'shadow'), keys);
    const fence = { accountId: 'a', scopeId: 'account:a', hostDeviceId: 'h', epoch: 1, leaseId: 'l' };
    let published: unknown[] = [];
    const svc = new ShadowHostDataService({
      host: core, keys, scopeKeyId: 'wk_test', fence, leaseExpiresAt: Date.now() + 60_000,
      session: async () => ({ accountId: 'a', hostDeviceId: 'h', sessionToken: 't', relayOrigin: 'http://127.0.0.1:1' }),
      signer: { keyId: 'sk', sign: async () => new Uint8Array(64) },
      transport: {
        fetch: async (_url, init) => {
          if (init.body) published = (JSON.parse(init.body).events ?? []) as unknown[];
          return { status: 200, ok: true, text: async () => '{"accepted":1,"headSeq":1}' };
        },
        allowInsecureLoopback: true,
      },
      commandRegistry: defineShadowCommandRegistry({}),
    });
    const event = svc.appendEvent({ collection: 'project', op: 'upsert', entityId: 'p1', revision: 1, payload: { n: 1 } });
    expect(event.eventId).toBeTruthy();
    expect(await svc.publish()).toBe(1);
    // The event was re-sealed into a decode-valid self-contained wire envelope.
    expect(published).toHaveLength(1);
    expect(decodeShadowMessage(published[0], { nowMs: Date.now() }).ok).toBe(true);
    svc.close();
  });

  it('drains a large baseline in ordered contiguous batches without leaving pending events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-drain-'));
    const scopeKey = Buffer.alloc(32, 4);
    const keys = new StaticShadowKeyProvider('wk_drain', scopeKey);
    const core = new ShadowHostCore(join(dir, 'shadow'), keys);
    const fence = { accountId: 'a', scopeId: 'account:a', hostDeviceId: 'h', epoch: 1, leaseId: 'l' };
    const batches: number[][] = [];
    const svc = new ShadowHostDataService({
      host: core, keys, scopeKeyId: 'wk_drain', fence, leaseExpiresAt: Date.now() + 60_000,
      session: async () => ({ accountId: 'a', hostDeviceId: 'h', sessionToken: 't', relayOrigin: 'http://127.0.0.1:1' }),
      signer: { keyId: 'sk', sign: async () => new Uint8Array(64) },
      transport: {
        fetch: async (_url, init) => {
          const events = init.body ? (JSON.parse(init.body).events ?? []) as Array<{ seq: number }> : [];
          batches.push(events.map((e) => e.seq));
          return { status: 200, ok: true, text: async () => JSON.stringify({ accepted: events.length, headSeq: events.at(-1)?.seq ?? 0 }) };
        },
        allowInsecureLoopback: true,
      },
      commandRegistry: defineShadowCommandRegistry({}),
    });
    for (let i = 1; i <= 121; i++) {
      svc.appendEvent({ collection: 'project', op: 'upsert', entityId: `p_${i}`, revision: 1, payload: { n: i } });
    }
    await expect(svc.publishAllPending()).resolves.toBe(121);
    expect(batches.map((b) => b.length)).toEqual([100, 21]);
    expect(batches.flat()).toEqual(Array.from({ length: 121 }, (_, i) => i + 1));
    expect(core.debugSqlForTest('SELECT COUNT(*) AS n FROM events WHERE published=0')).toEqual([{ n: 0 }]);
    svc.close();
  }, 60_000);

  it('serializes concurrent publication entrypoints into one contiguous baseline drain', async () => {
    const gate = deferred<Response>();
    const firstRequestStarted = deferred();
    const batches: number[][] = [];
    const { svc, core } = makeDataService({
      relay: async (events) => {
        batches.push(events.map((e) => e.seq));
        if (batches.length === 1) {
          firstRequestStarted.resolve();
          return gate.promise;
        }
        return { status: 200, ok: true, text: async () => JSON.stringify({ accepted: events.length, headSeq: events.at(-1)?.seq ?? 0 }) };
      },
    });
    appendProjects(svc, 752);

    const callers = [
      svc.publishAllPending(),
      svc.publish(),
      svc.publishAllPending(1, 10),
      svc.publishAllPending(20, 100),
      svc.publishAllPending(100, 500),
    ];
    await firstRequestStarted.promise;
    expect(batches).toHaveLength(1);
    gate.resolve({ status: 200, ok: true, text: async () => JSON.stringify({ accepted: 100, headSeq: 100 }) });

    await expect(Promise.all(callers)).resolves.toEqual([752, 752, 752, 752, 752]);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 100, 100, 100, 100, 100, 52]);
    expect(batches.flat()).toEqual(Array.from({ length: 752 }, (_, i) => i + 1));
    expect(core.debugSqlForTest('SELECT COUNT(*) AS n FROM events WHERE published=0')).toEqual([{ n: 0 }]);
    svc.close();
  }, 60_000);

  it('shares network failure across concurrent callers and clears the drain for retry', async () => {
    let fail = true;
    let requests = 0;
    const { svc, core } = makeDataService({
      relay: async (events) => {
        requests += 1;
        if (fail) throw new Error('relay-down');
        return { status: 200, ok: true, text: async () => JSON.stringify({ accepted: events.length, headSeq: events.at(-1)?.seq ?? 0 }) };
      },
    });
    appendProjects(svc, 121);

    await expect(Promise.all([svc.publishAllPending(), svc.publish(), svc.publishAllPending()])).rejects.toThrow(/shadow request failed/);
    expect(requests).toBe(1);
    expect(core.debugSqlForTest('SELECT COUNT(*) AS n FROM events WHERE published=0')).toEqual([{ n: 121 }]);

    fail = false;
    await expect(svc.publishAllPending()).resolves.toBe(121);
    expect(requests).toBe(3);
    expect(core.debugSqlForTest('SELECT COUNT(*) AS n FROM events WHERE published=0')).toEqual([{ n: 0 }]);
    svc.close();
  }, 20_000);

  it('fails closed when the service closes after relay accept but before local publish marks', async () => {
    const gate = deferred<Response>();
    const relayStarted = deferred();
    const { svc, core } = makeDataService({
      relay: async () => {
        relayStarted.resolve();
        return gate.promise;
      },
    });
    const sqlitePath = core.paths.sqlitePath;
    appendProjects(svc, 3);

    const inFlight = svc.publishAllPending();
    await relayStarted.promise;
    svc.close();
    gate.resolve({ status: 200, ok: true, text: async () => JSON.stringify({ accepted: 3, headSeq: 3 }) });

    await expect(inFlight).rejects.toThrow(/publish-service-closed/);
    expect(countUnpublished(sqlitePath)).toBe(3);
  }, 20_000);
});
