/**
 * Phase 3A2b1 §1-C mobile — integrity-protected approved-capability persistence +
 * reload re-verification. A real host-signed grant carries the approved set; the
 * mobile persists it + a capability proof; on reload the runtime re-verifies the set
 * against the host signature, and a locally-tampered copy fails closed (locked).
 */
import { describe, it, expect } from 'vitest';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import { base64urlEncode, base64urlDecode } from '@maestro/realtime/shadowCrypto';
import {
  generateShadowIdentity, createEnrollmentSession, decodeEnrollmentBootstrap, encodeEnrollmentBootstrap,
  buildEnrollmentRequest, approveEnrollment, verifyEnrollmentRequest,
} from '@maestro/realtime/shadowEnrollment';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import type { ShadowFetch } from '@maestro/realtime/shadowRequestClient';
import { ShadowMobileEnrollmentRuntime, type SecureStoreAdapter, type EnrollmentMetaStore, type StoredGrantMeta } from './shadowEnrollmentClient';

const ORIGIN = 'https://relay.test';
const ACCOUNT = 'acct_cap';
const NOW = 1_700_000_000_000;

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
const noFetch: ShadowFetch = async () => ({ status: 500, ok: false, text: async () => '{}' });

/** Produce a real signed grant + the StoredGrantMeta the runtime would persist. */
async function makePersistedGrant(approved: ShadowCapability[], requested: ShadowCapability[]): Promise<{ meta: StoredGrantMeta; scopeKey: string; scopeIdKey: string }> {
  const host = await generateShadowIdentity(backend, 'host_cap');
  const controller = await generateShadowIdentity(backend, 'ctrl_cap');
  const creation = await createEnrollmentSession(backend, { host, accountId: ACCOUNT, relayOrigin: ORIGIN, nowMs: NOW, serverPepper: new TextEncoder().encode('p') });
  const decoded = decodeEnrollmentBootstrap(encodeEnrollmentBootstrap(creation.bootstrap), { allowedOrigins: [ORIGIN], nowMs: NOW + 1 });
  if (!decoded.ok) throw new Error('bootstrap');
  const { request } = await buildEnrollmentRequest(backend, { controller, bootstrap: decoded.value, nowMs: NOW + 2000, requestedCapabilities: requested });
  const verified = await verifyEnrollmentRequest(backend, { request, bootstrap: creation.bootstrap, expectedAccountId: ACCOUNT, nowMs: NOW + 3000 });
  if (!verified.ok) throw new Error(verified.reason);
  const fence = { accountId: ACCOUNT, scopeId: `account:${ACCOUNT}`, hostDeviceId: host.deviceId, epoch: 1, leaseId: 'l' };
  const approval = await approveEnrollment(backend, {
    host, fence, controllerDeviceId: controller.deviceId, controllerAgreementPublicKey: verified.controllerAgreementPublicKey,
    transcriptHash: verified.transcriptHash, sessionId: request.sessionId, nowMs: NOW + 3500, capabilities: approved, requestedCapabilities: verified.requestedCapabilities,
  });
  const g = approval.grant;
  const meta: StoredGrantMeta = {
    sessionId: request.sessionId, controllerDeviceId: controller.deviceId, grantId: g.grantId, keyId: g.keyId, scopeKeyId: approval.scopeKeyId,
    fence, expiresAt: g.expiresAt, transcriptHash: approval.keyMaterial.transcriptHash,
    hostSigningKeyId: host.signingKeyId, hostSigningPublicKey: base64urlEncode(host.signingPublicKey), leaseExpiresAt: NOW + 60_000, status: 'active',
    approvedCapabilities: approval.capabilities as ShadowCapability[],
    capabilityProof: { grantId: g.grantId, keyId: g.keyId, expiresAt: g.expiresAt, signedAt: g.signedAt, signature: g.signature },
  };
  return { meta, scopeKey: base64urlEncode(approval.scopeKey), scopeIdKey: `shadow.scope.${fence.scopeId}.${controller.deviceId}` };
}

function runtimeWith(meta: StoredGrantMeta, scopeKey: string) {
  const metaStore = new MemMeta(); metaStore.g = meta;
  const secureStore = new MemSecureStore();
  // Matches the runtime's `secureKeyScope(scopeId, controllerDeviceId)` format.
  secureStore.m.set(`maestro.shadow.scopeKey.${meta.controllerDeviceId}.${meta.fence.scopeId}`, scopeKey);
  const rt = new ShadowMobileEnrollmentRuntime({
    backend, secureStore, metaStore,
    session: { get: async () => ({ accountId: ACCOUNT, controllerDeviceId: meta.controllerDeviceId, sessionToken: 'tok', relayOrigin: ORIGIN }) },
    transport: { fetch: noFetch }, allowedOrigins: [ORIGIN], now: () => NOW + 4000,
  });
  return { rt, metaStore };
}

describe('mobile approved-capability persistence + reload re-verify (§1-C)', () => {
  it('reload verifies the approved subset from the signed grant proof', async () => {
    const { meta, scopeKey } = await makePersistedGrant(['account.read', 'session.message'], ['account.read', 'session.message', 'job.start']);
    const { rt } = runtimeWith(meta, scopeKey);
    await rt.restore();
    const caps = await rt.verifiedApprovedCapabilities();
    expect(caps).toEqual(['account.read', 'session.message']);
  });

  it('a TAMPERED approved-capability copy fails closed (locked, null)', async () => {
    const { meta, scopeKey } = await makePersistedGrant(['account.read', 'session.message'], ['account.read', 'session.message', 'job.start']);
    // Attacker widens the persisted approved set beyond what the host signed.
    const tampered: StoredGrantMeta = { ...meta, approvedCapabilities: ['account.read', 'session.message', 'job.start'] };
    const { rt } = runtimeWith(tampered, scopeKey);
    const st = await rt.restore();
    expect(st.state).toBe('locked');
    expect(await rt.verifiedApprovedCapabilities()).toBeNull();
  });

  it('a tampered capability-proof signature fails closed (locked)', async () => {
    const { meta, scopeKey } = await makePersistedGrant(['account.read', 'job.cancel'], ['account.read', 'job.cancel']);
    const tampered: StoredGrantMeta = { ...meta, capabilityProof: { ...meta.capabilityProof!, signature: 'a'.repeat(86) } };
    const { rt } = runtimeWith(tampered, scopeKey);
    expect((await rt.restore()).state).toBe('locked');
  });

  it('a legacy grant without a proof reloads read-only (account.read)', async () => {
    const { meta, scopeKey } = await makePersistedGrant(['account.read', 'job.start'], ['account.read', 'job.start']);
    const { approvedCapabilities, capabilityProof, ...legacy } = meta; // strip capability fields
    void approvedCapabilities; void capabilityProof;
    const { rt } = runtimeWith(legacy as StoredGrantMeta, scopeKey);
    await rt.restore();
    expect(await rt.verifiedApprovedCapabilities()).toEqual(['account.read']);
  });
});
