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
import { decodeShadowMessage } from '@maestro/realtime';
import { ShadowHostCore, StaticShadowKeyProvider } from './shadow-host.ts';
import { ShadowHostDataService, defineShadowCommandRegistry } from './shadow-host-service.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

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
});
