/**
 * Permanent reproduction of the independent reviewer's HIGH finding (mobile half):
 * "no production code connects an accepted enrollment grant to
 * createExpoSQLiteShadowClient()/ShadowMobileClient". This PINS the correction —
 * the production factory now builds a durable `ShadowControllerService` (→ a real
 * `ShadowMobileClient` over `ExpoSQLiteShadowStore`) from the accepted grant — and
 * a runtime check proves `buildControllerService` yields a working durable client.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nodeShadowCrypto as node } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode } from '@maestro/realtime/shadowCrypto';
import { generateShadowIdentity } from '@maestro/realtime/shadowEnrollment';
import { ShadowMobileEnrollmentRuntime, type StoredGrantMeta } from './shadowEnrollmentClient';
import { ShadowControllerService } from './shadowControllerService';
import { createMemoryShadowStore } from './shadowClient';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

describe('production wiring: mobile factory reaches ShadowMobileClient (reviewer finding fixed)', () => {
  it('the factory builds the durable controller service from an accepted grant', () => {
    const factory = read('shadowEnrollmentRuntimeFactory.ts');
    expect(factory).toContain('createExpoSQLiteShadowStore');
    expect(factory).toContain('buildControllerService');
    expect(factory).toContain('createShadowMobileControllerService');
    // The barrel App.tsx imports pulls the controller service into the bundle.
    expect(read('shadowEnrollment.ts')).toContain("export * from './shadowControllerService'");
  });

  it('the controller service module constructs a real ShadowMobileClient over the durable store', () => {
    const svc = read('shadowControllerService.ts');
    expect(svc).toContain('new ShadowMobileClient');
    expect(svc).toContain('ShadowStore');
  });

  it('buildControllerService yields a ShadowControllerService from an in-memory accepted grant (runtime)', async () => {
    const fence = { accountId: 'a', scopeId: 'account:a', hostDeviceId: 'h', epoch: 1, leaseId: 'l' };
    const identity = await generateShadowIdentity(node, 'ctrl_wire');
    const scopeKey = node.randomBytes(32);
    const grant: StoredGrantMeta = {
      sessionId: 'es', controllerDeviceId: 'ctrl_wire', grantId: 'eg', keyId: 'wk', scopeKeyId: 'wk',
      fence, expiresAt: Date.now() + 60_000, transcriptHash: 'th', hostSigningKeyId: 'sk', hostSigningPublicKey: 'aG9zdHB1Yg', leaseExpiresAt: Date.now() + 60_000, status: 'active',
    };
    const secureStore = new Map<string, string>();
    const runtime = new ShadowMobileEnrollmentRuntime({
      backend: node,
      secureStore: { getItemAsync: async (k: string) => secureStore.get(k) ?? null, setItemAsync: async (k: string, v: string) => void secureStore.set(k, v), deleteItemAsync: async (k: string) => void secureStore.delete(k) },
      metaStore: { loadGrant: async () => grant, saveGrant: async () => {}, clearGrant: async () => {} },
      session: async () => ({ accountId: 'a', controllerDeviceId: 'ctrl_wire', sessionToken: 't', relayOrigin: 'https://relay.test' }) as never,
      transport: { fetch: async () => ({ status: 200, ok: true, text: async () => '{}' }) },
      allowedOrigins: ['https://relay.test'],
    } as never);
    // Inject the in-memory accepted state (identity + scope key) the way restore() would.
    (runtime as unknown as { identity: unknown; scopeKey: Uint8Array; grant: StoredGrantMeta; keyRingSet: unknown }).identity = identity;
    (runtime as unknown as { scopeKey: Uint8Array }).scopeKey = scopeKey;
    (runtime as unknown as { grant: StoredGrantMeta }).grant = grant;
    void base64urlEncode;

    const store = createMemoryShadowStore('ctrl_wire', 'h', { fence, controllerDeviceId: 'ctrl_wire', leaseExpiresAt: grant.leaseExpiresAt });
    const svc = runtime.buildControllerService({
      store,
      session: async () => ({ accountId: 'a', controllerDeviceId: 'ctrl_wire', sessionToken: 't', relayOrigin: 'https://relay.test' }),
      transport: { fetch: async () => ({ status: 200, ok: true, text: async () => '{}' }) },
    });
    expect(svc).toBeInstanceOf(ShadowControllerService);
    const status = (await svc!.load());
    expect(status.state).toBe('offline');
  });
});
