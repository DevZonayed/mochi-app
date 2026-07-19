/**
 * shadow-enrollment-host — Phase 3A2a desktop (macOS WebKit) host enrollment
 * runtime. Drives the native-controller enrollment lifecycle against the
 * independently-approved Phase 3A0/3A1 relay:
 *
 *   identity (TOFU register) → lease/fence → create session (256-bit one-time
 *   secret, ≤5m TTL, host-computed verifier) → QR bootstrap → list pending →
 *   explicit approve (wrap scope key to controller) → deny/cancel → list
 *   controllers → atomic revoke + scope-key rotation for the survivors.
 *
 * Security boundary:
 *  - Ed25519/X25519 private seeds and the account scope key live at rest ONLY as
 *    OS-vault ciphertext (the injected {@link SecureVault}, backed in production
 *    by the Keychain-provisioned safeStorage MS1 envelope). No plaintext key,
 *    one-time secret, or QR payload is ever persisted or logged. If the vault is
 *    unavailable the runtime fails closed.
 *  - Every private-key operation stays in this trusted brain module; only
 *    allowlisted create/list/approve/deny/cancel/revoke/status results (and, for
 *    the active operator-created session, the QR payload) are returned to the
 *    caller. The QR is redacted from every log line.
 *  - Approval is an explicit API call — never automatic.
 *
 * The runtime is fully dependency-injected (vault, persistence, session, signed
 * transport, clock) so it runs identically under an in-memory TEST vault in the
 * cross-tier E2E and under the real safeStorage + local API/dispatch in-app.
 */
import {
  generateShadowIdentity,
  materializeIdentity,
  createEnrollmentSession,
  encodeEnrollmentBootstrap,
  approveEnrollment,
  signDeviceRevocation,
  type ShadowIdentity,
  type ShadowIdentityKeys,
} from '@maestro/realtime/shadowEnrollment';
import {
  base64urlEncode,
  base64urlDecode,
  structuredEncode,
  humanVerificationPhrase,
} from '@maestro/realtime/shadowCrypto';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import type { Fence } from '@maestro/realtime/shadowProtocol';
import { canonicalizeCapabilities, type ShadowCapability } from '@maestro/realtime/shadowCapabilities';
/** Canonicalise a capability value, failing closed to the read floor. */
function hostSafeCaps(value: unknown): ShadowCapability[] {
  const c = canonicalizeCapabilities(value);
  return c.ok ? c.capabilities : ['account.read'];
}
import {
  ShadowRequestClient,
  type ShadowSession,
  type ShadowRequestSigner,
  type ShadowTransportConfig,
} from '@maestro/realtime/shadowRequestClient';
import { ShadowHostCore, StaticShadowKeyProvider } from './shadow-host.js';
import { ShadowHostDataService, type ShadowCommandRegistry } from './shadow-host-service.js';
import { ShadowProductProjection, type ProjectionStoreReader } from './shadow-product-projection.js';
import { signAuthorityTransition, type AuthorityTransitionGrantFields } from '@maestro/realtime/shadowAuthorityTransition';

const backend = nodeShadowCrypto;
/** Must match the server's HOST_REGISTER_DOMAIN in shadowEnrollmentService.ts. */
const HOST_REGISTER_DOMAIN = 'maestro.shadow.host-register.v1';

// ── Injected boundaries ────────────────────────────────────────────────────

/** OS-backed encrypted storage (mirror of the Electron/safeStorage shim). */
export interface SecureVault {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Uint8Array;
  decryptString(ciphertext: Uint8Array): string;
}

/** Durable, crash-safe JSON record home (Store field or userData file). */
export interface HostEnrollmentPersistence {
  load(): HostEnrollmentRecord | null;
  save(record: HostEnrollmentRecord): void;
}

/** Better Auth account session + host device id + relay origin. */
export interface HostSessionProvider {
  /** accountId (server session user id), hostDeviceId, Better Auth token, origin. */
  get(): Promise<{ accountId: string; hostDeviceId: string; sessionToken: string; relayOrigin: string }>;
}

/** Persisted record. Secret material appears ONLY as vault ciphertext (base64url). */
export interface HostEnrollmentRecord {
  version: 1;
  hostDeviceId: string;
  identityCipher: string | null; // vault(JSON{signingSeed, agreementSeed})
  scopeKeyCipher: string | null; // vault(scope key bytes)
  signingKeyId: string | null;
  agreementKeyId: string | null;
  fingerprint: string | null;
  registered: boolean;
  fence: Fence | null;
  leaseExpiresAt: number | null;
  revocationSeq: number;
  controllers: HostControllerRecord[];
  sessions: HostSessionRecord[];
  /**
   * Durable lease-renewal INTENT: signed grants + exact requested expiry persisted
   * BEFORE the atomic server renewal, so a crash between server acceptance and local
   * persistence is recovered by replaying the same `renewalId`. Only IDs/fences/public
   * signed grants — no private/scope plaintext. At most one pending intent per scope.
   */
  pendingLeaseRenewal?: PendingLeaseRenewal;
}

export interface PendingLeaseRenewal {
  renewalId: string;
  previousFence: Fence;
  previousExpiresAt: number;
  requestedExpiresAt: number;
  createdAt: number;
  signedGrants: AuthorityTransitionGrantFields[]; // host-signed; public (no secret)
  activeControllerIds: string[];
  status: 'pending';
}

/** Requested lease TTL for a renewal (bounded well under the server's 5-minute max). */
const LEASE_RENEW_TTL_MS = 4 * 60_000;

export type HostRenewalCrashPoint = 'after-intent-before-server' | 'after-server-before-local' | 'after-local-before-clear';

export interface HostControllerRecord {
  controllerDeviceId: string;
  grantId: string;
  keyId: string;
  agreementPublicKey: string; // base64url (public)
  /** base64url raw Ed25519 controller signing pubkey — persisted (Phase 3D1) so the
   * host can verify the controller's SIGNED screen-start before any capture. */
  signingPublicKey?: string;
  transcriptHash: string; // base64url (public)
  status: 'active' | 'revoked';
  /** Host-approved canonical capability set bound into the grant. Absent = legacy `account.read`. */
  capabilities?: readonly ShadowCapability[];
}

export interface HostSessionRecord {
  sessionId: string;
  expiresAt: number;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
}

export interface ShadowHostRuntimeOptions {
  vault: SecureVault;
  persistence: HostEnrollmentPersistence;
  session: HostSessionProvider;
  /** Overrides for the signed transport (fetch, allowInsecureLoopback, timeouts). */
  transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
  now?: () => number;
}

export type HostRuntimeState = 'stopped' | 'starting' | 'running' | 'vault-unavailable' | 'error';

export interface HostRuntimeStatus {
  state: HostRuntimeState;
  hostDeviceId: string | null;
  fingerprint: string | null;
  vaultAvailable: boolean;
  registered: boolean;
  epoch: number | null;
  activeSessions: number;
  controllers: number;
  lastError?: string;
}

export interface PendingEnrollmentRequestView {
  sessionId: string;
  controllerDeviceId: string;
  signingPublicKey: string;
  agreementPublicKey: string;
  nonce: string;
  requestedAt: number;
  transcriptHash: string;
  /** Short authentication string over the signed transcript (compare out-of-band). */
  authString: string;
  sessionExpiresAt: number;
  /** Controller-signed requested capability set (server-verified). Host may approve a subset. */
  requestedCapabilities: ShadowCapability[];
}

export interface CreateSessionResult {
  sessionId: string;
  /** Versioned QR/deep-link payload containing the one-time secret. Do not log. */
  qr: string;
  expiresAt: number;
  hostFingerprint: string;
  /** Host verification phrase (for the operator to compare against the phone). */
  hostAuthString: string;
}

function errStatus(message: string, statusCode = 500): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function scopeFor(accountId: string): string {
  return `account:${accountId}`;
}

function emptyRecord(hostDeviceId: string): HostEnrollmentRecord {
  return {
    version: 1, hostDeviceId, identityCipher: null, scopeKeyCipher: null,
    signingKeyId: null, agreementKeyId: null, fingerprint: null, registered: false,
    fence: null, leaseExpiresAt: null, revocationSeq: 0, controllers: [], sessions: [],
  };
}

/**
 * The desktop host enrollment runtime. Instantiated once per boot in the sidecar
 * brain and exposed behind the local API/dispatch for 3A2b.
 */
export class ShadowHostEnrollmentRuntime {
  private state: HostRuntimeState = 'stopped';
  private lastError: string | undefined;
  private record: HostEnrollmentRecord;
  private identity: ShadowIdentity | null = null;
  private scopeKey: Uint8Array | null = null;
  private renewalCrashPoint: HostRenewalCrashPoint | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: ShadowHostRuntimeOptions) {
    this.now = opts.now ?? Date.now;
    this.record = opts.persistence.load() ?? emptyRecord('');
  }

  status(): HostRuntimeStatus {
    return {
      state: this.state,
      hostDeviceId: this.record.hostDeviceId || null,
      fingerprint: this.record.fingerprint,
      vaultAvailable: this.opts.vault.isEncryptionAvailable(),
      registered: this.record.registered,
      epoch: this.record.fence?.epoch ?? null,
      activeSessions: this.record.sessions.filter((s) => s.status === 'pending').length,
      controllers: this.record.controllers.filter((c) => c.status === 'active').length,
      lastError: this.lastError,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<HostRuntimeStatus> {
    if (this.state === 'running' || this.state === 'starting') return this.status();
    this.state = 'starting';
    this.lastError = undefined;
    try {
      if (!this.opts.vault.isEncryptionAvailable()) {
        this.state = 'vault-unavailable';
        throw errStatus('secure vault unavailable', 503);
      }
      const s = await this.opts.session.get();
      if (this.record.hostDeviceId && this.record.hostDeviceId !== s.hostDeviceId) {
        // Device id changed under us — start fresh (do not reuse another device's identity).
        this.record = emptyRecord(s.hostDeviceId);
      }
      this.record.hostDeviceId = s.hostDeviceId;
      await this.loadOrCreateIdentity();
      await this.registerHost(s);
      await this.acquireLease(s);
      this.persist();
      this.state = 'running';
      return this.status();
    } catch (e) {
      if (this.state !== 'vault-unavailable') this.state = 'error';
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  /**
   * Stop: atomically cancel every outstanding pending session (no restart
   * continuity for one-time secrets by default) and drop in-memory secrets.
   */
  async stop(): Promise<void> {
    const pending = this.record.sessions.filter((s) => s.status === 'pending');
    for (const s of pending) {
      try {
        await this.cancel({ sessionId: s.sessionId });
      } catch {
        // best-effort; mark cancelled locally so a restart never resurrects it
        s.status = 'cancelled';
      }
    }
    this.persist();
    if (this.scopeKey) this.scopeKey.fill(0);
    this.scopeKey = null;
    this.identity = null;
    this.state = 'stopped';
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  async createEnrollmentSession(input: { ttlMs?: number } = {}): Promise<CreateSessionResult> {
    const { s, identity } = await this.requireRunning();
    const created = await createEnrollmentSession(backend, {
      host: identity,
      accountId: s.accountId,
      relayOrigin: s.relayOrigin,
      nowMs: this.now(),
      ttlMs: input.ttlMs,
      serverPepper: enrollmentPepper(),
    });
    const client = await this.enrolledClient(s);
    const res = await client.requestEnrolled(this.shadowSession(s), this.signer(identity), {
      method: 'POST',
      path: '/api/shadow/enroll/session',
      body: {
        sessionId: created.sessionId,
        hostSigningKeyId: identity.signingKeyId,
        secretSalt: created.serverRecord.secretVerifier.salt,
        secretVerifier: created.serverRecord.secretVerifier.verifier,
        relayOrigin: s.relayOrigin,
        ttlMs: input.ttlMs,
        expectedFingerprint: identity.signingKeyId,
      },
    });
    if (!res.ok) throw errStatus(res.error ?? 'create session failed', res.status);
    this.record.sessions.push({ sessionId: created.sessionId, expiresAt: created.bootstrap.expiresAt, status: 'pending' });
    this.persist();
    return {
      sessionId: created.sessionId,
      qr: encodeEnrollmentBootstrap(created.bootstrap),
      expiresAt: created.bootstrap.expiresAt,
      hostFingerprint: identity.signingKeyId,
      hostAuthString: await humanVerificationPhrase(backend, identity.signingKeyId),
    };
  }

  async listPendingRequests(): Promise<PendingEnrollmentRequestView[]> {
    const { s, identity } = await this.requireRunning();
    const client = await this.enrolledClient(s);
    const res = await client.requestEnrolled<{ requests: RawPendingRequest[] }>(this.shadowSession(s), this.signer(identity), {
      method: 'GET',
      path: '/api/shadow/enroll/requests',
    });
    if (!res.ok) throw errStatus(res.error ?? 'list pending failed', res.status);
    const requests = res.json?.requests ?? [];
    const views: PendingEnrollmentRequestView[] = [];
    for (const r of requests) {
      views.push({
        sessionId: r.sessionId,
        controllerDeviceId: r.controllerDeviceId,
        signingPublicKey: r.signingPublicKey,
        agreementPublicKey: r.agreementPublicKey,
        nonce: r.nonce,
        requestedAt: r.requestedAt,
        transcriptHash: r.transcriptHash,
        authString: await humanVerificationPhrase(backend, r.transcriptHash),
        sessionExpiresAt: r.sessionExpiresAt,
        // Canonicalise the server-verified requested set (fail-closed to account.read).
        requestedCapabilities: hostSafeCaps(r.requestedCapabilities),
      });
    }
    return views;
  }

  /** Explicit host approval. Wraps the current scope key to the controller. */
  async approve(input: { sessionId: string; controllerName?: string; controllerPlatform?: string; capabilities?: readonly ShadowCapability[] }): Promise<{ grantId: string; controllerDeviceId: string; keyId: string; expiresAt: number; capabilities?: readonly ShadowCapability[] }> {
    const { s, identity } = await this.requireRunning();
    const fence = this.requireFence();
    const scopeKey = this.requireScopeKey();
    const pending = await this.listPendingRequests();
    const req = pending.find((r) => r.sessionId === input.sessionId);
    if (!req) throw errStatus('no pending request for session', 404);

    // Host-selected approved capability set (least privilege). Undefined = legacy
    // `account.read` grant. The set is canonicalised + bound into the host-signed grant
    // by approveEnrollment; execution-time enforcement uses the persisted record below.
    const approval = await approveEnrollment(backend, {
      host: identity,
      fence,
      controllerDeviceId: req.controllerDeviceId,
      controllerAgreementPublicKey: base64urlDecode(req.agreementPublicKey),
      transcriptHash: base64urlDecode(req.transcriptHash),
      sessionId: input.sessionId,
      nowMs: this.now(),
      scopeKey,
      capabilities: input.capabilities,
      // Enforce host-selected ⊆ the server-verified requested set (no self-escalation).
      requestedCapabilities: req.requestedCapabilities,
    });
    const client = await this.enrolledClient(s);
    const res = await client.requestEnrolled<{ grantId: string; controllerDeviceId: string; status: string; keyId: string; expiresAt: number }>(
      this.shadowSession(s),
      this.signer(identity),
      {
        method: 'POST',
        path: '/api/shadow/enroll/approve',
        body: {
          sessionId: input.sessionId,
          grant: approval.grant,
          keyMaterial: approval.keyMaterial,
          controllerName: input.controllerName,
          controllerPlatform: input.controllerPlatform,
        },
      },
    );
    if (!res.ok || !res.json) throw errStatus(res.error ?? 'approve failed', res.status);
    this.record.controllers = this.record.controllers.filter((c) => c.controllerDeviceId !== req.controllerDeviceId);
    this.record.controllers.push({
      controllerDeviceId: req.controllerDeviceId,
      grantId: approval.grant.grantId,
      keyId: approval.grant.keyId,
      agreementPublicKey: req.agreementPublicKey,
      signingPublicKey: req.signingPublicKey,
      transcriptHash: req.transcriptHash,
      status: 'active',
      ...(approval.capabilities ? { capabilities: approval.capabilities } : {}),
    });
    const sess = this.record.sessions.find((x) => x.sessionId === input.sessionId);
    if (sess) sess.status = 'approved';
    this.persist();
    return { grantId: res.json.grantId, controllerDeviceId: res.json.controllerDeviceId, keyId: res.json.keyId, expiresAt: res.json.expiresAt, capabilities: approval.capabilities };
  }

  /**
   * AUTHORITATIVE per-controller approved capabilities from the host record, for the
   * data service's execution-time capability check. Returns the canonical set for an
   * ACTIVE controller, or `null` (→ default `account.read`) for unknown/revoked.
   */
  capabilitiesFor(controllerDeviceId: string): readonly ShadowCapability[] | null {
    const c = this.record.controllers.find((x) => x.controllerDeviceId === controllerDeviceId && x.status === 'active');
    return c ? (c.capabilities ?? ['account.read']) : null;
  }

  /**
   * Phase 3D1 (B2): the host key material a `ScreenStreamHostCoordinator` needs. Raw
   * private bytes flow only runtime → coordinator (never persisted/logged/relayed).
   * Null until the identity is loaded (host `start()` completes).
   */
  screenHostKeyMaterial(): { hostAgreementPrivate: Uint8Array; hostSigningPrivate: Uint8Array; hostSigningKeyId: string } | null {
    if (!this.identity) return null;
    return {
      hostAgreementPrivate: this.identity.keys.agreement.privateKey,
      hostSigningPrivate: this.identity.keys.signing.privateKey,
      hostSigningKeyId: this.identity.signingKeyId,
    };
  }

  /** The enrolled X25519 agreement PUBLIC key of an ACTIVE controller (for stream key
   * derivation), or null for unknown/revoked. */
  controllerAgreementPublicFor(controllerDeviceId: string): Uint8Array | null {
    const c = this.record.controllers.find((x) => x.controllerDeviceId === controllerDeviceId && x.status === 'active');
    if (!c) return null;
    try { return base64urlDecode(c.agreementPublicKey); } catch { return null; }
  }

  /** The enrolled Ed25519 signing PUBLIC key of an ACTIVE controller (for verifying its
   * signed screen-start), or null for unknown/revoked/legacy-record-without-key. */
  controllerSigningPublicFor(controllerDeviceId: string): Uint8Array | null {
    const c = this.record.controllers.find((x) => x.controllerDeviceId === controllerDeviceId && x.status === 'active');
    if (!c || !c.signingPublicKey) return null;
    try { return base64urlDecode(c.signingPublicKey); } catch { return null; }
  }

  /**
   * Phase 3B0 NOTE-2: the device ids this host has REVOKED. This set must be fed
   * into the live `ShadowHostDataService` authority so the fence `revoked` branch
   * denies a revoked controller on EVERY command mode (read-only enumeration
   * included) — not just after an app restart.
   */
  revokedControllerDeviceIds(): string[] {
    return this.record.controllers.filter((c) => c.status === 'revoked').map((c) => c.controllerDeviceId);
  }

  /** The scope-key id the live data plane must decrypt/seal with (active controller's keyId), or null. */
  currentScopeKeyId(): string | null {
    return this.record.controllers.find((c) => c.status === 'active')?.keyId ?? null;
  }

  /**
   * Phase 3B0 NOTE-2: the single authoritative set of inputs for refreshing the
   * live data service after a lease renewal / rotation / controller revoke —
   * current fence, lease expiry, rotated scope-key id, and the revoked set.
   * Returns null before a fence exists.
   */
  liveAuthority(): { fence: Fence; leaseExpiresAt: number; revokedControllerDeviceIds: string[]; scopeKeyId: string | null } | null {
    if (!this.record.fence) return null;
    return {
      fence: this.record.fence,
      leaseExpiresAt: this.record.leaseExpiresAt ?? this.now() + 300_000,
      revokedControllerDeviceIds: this.revokedControllerDeviceIds(),
      scopeKeyId: this.currentScopeKeyId(),
    };
  }

  async deny(input: { sessionId: string }): Promise<void> {
    await this.simpleSessionOp('deny', input.sessionId, 'denied');
  }

  async cancel(input: { sessionId: string }): Promise<void> {
    await this.simpleSessionOp('cancel', input.sessionId, 'cancelled');
  }

  async listControllers(): Promise<Array<{ controllerDeviceId: string; grantId: string; keyId: string; status: string; expiresAt: number }>> {
    const { s, identity } = await this.requireRunning();
    const client = await this.enrolledClient(s);
    const res = await client.requestEnrolled<{ controllers: Array<{ controllerDeviceId: string; grantId: string; keyId: string; status: string; expiresAt: number }> }>(
      this.shadowSession(s),
      this.signer(identity),
      { method: 'GET', path: '/api/shadow/enroll/controllers' },
    );
    if (!res.ok) throw errStatus(res.error ?? 'list controllers failed', res.status);
    return res.json?.controllers ?? [];
  }

  /**
   * Atomic revocation + scope-key rotation for the survivors. The new scope key
   * is only committed to the local vault AFTER the relay accepts the signed
   * revocation, so a relay failure leaves the host's key state unchanged
   * (fail-closed, deterministic recovery — never a partial controller list).
   */
  async revoke(input: { controllerDeviceId: string }): Promise<{ keyRotationId: string; alreadyRevoked: boolean }> {
    const { s, identity } = await this.requireRunning();
    const fence = this.requireFence();
    const target = this.record.controllers.find((c) => c.controllerDeviceId === input.controllerDeviceId && c.status === 'active');
    if (!target) throw errStatus('controller not enrolled', 404);
    const remaining = this.record.controllers.filter((c) => c.controllerDeviceId !== input.controllerDeviceId && c.status === 'active');

    const nowMs = this.now();
    const revokedAt = nowMs;
    const keyRotationId = 'kr_' + base64urlEncode(backend.randomBytes(12));
    const effectiveSeq = this.record.revocationSeq + 1;
    const revocation = await signDeviceRevocation(backend, identity, {
      family: 'device-revocation', v: 1, fence, controllerDeviceId: input.controllerDeviceId, revokedAt, keyRotationId,
    });

    // Rotate the scope key to the survivors, reusing each survivor's EXISTING
    // grantId (the relay updates the existing grant row's ciphertext in place).
    const newScopeKey = backend.randomBytes(32);
    const rotations: Array<{ controllerDeviceId: string; grantId: string; keyId: string; wrapNonce: string; wrappedScopeKey: string }> = [];
    const updatedKeyIds = new Map<string, string>();
    for (const c of remaining) {
      const approval = await approveEnrollment(backend, {
        host: identity, fence, controllerDeviceId: c.controllerDeviceId,
        controllerAgreementPublicKey: base64urlDecode(c.agreementPublicKey),
        transcriptHash: base64urlDecode(c.transcriptHash),
        sessionId: 'rotation', nowMs, grantId: c.grantId, scopeKey: newScopeKey,
      });
      rotations.push({
        controllerDeviceId: c.controllerDeviceId, grantId: c.grantId, keyId: approval.grant.keyId,
        wrapNonce: approval.keyMaterial.wrapNonce, wrappedScopeKey: approval.keyMaterial.wrappedScopeKey,
      });
      updatedKeyIds.set(c.controllerDeviceId, approval.grant.keyId);
    }

    const client = await this.enrolledClient(s);
    const res = await client.requestEnrolled<{ ok: boolean; keyRotationId: string; alreadyRevoked: boolean }>(
      this.shadowSession(s),
      this.signer(identity),
      {
        method: 'POST',
        path: '/api/shadow/enroll/revoke',
        body: { scopeId: fence.scopeId, controllerDeviceId: input.controllerDeviceId, revocation, effectiveSeq, remainingRotations: rotations },
      },
    );
    if (!res.ok || !res.json) throw errStatus(res.error ?? 'revoke failed', res.status);

    // Commit local state only now (fail-closed): rotate the vault scope key,
    // mark the revoked controller, and bump each survivor's keyId + the seq.
    this.setScopeKey(newScopeKey);
    target.status = 'revoked';
    for (const c of this.record.controllers) {
      const nk = updatedKeyIds.get(c.controllerDeviceId);
      if (nk) c.keyId = nk;
    }
    this.record.revocationSeq = effectiveSeq;
    this.persist();
    return { keyRotationId: res.json.keyRotationId, alreadyRevoked: res.json.alreadyRevoked };
  }

  /**
   * Compose a production `ShadowHostDataService` over a real `ShadowHostCore`
   * using this runtime's ENROLLED scope key + authority fence — the durable
   * state/command plane the enrolled controllers drive. The scope key stays
   * encapsulated in this runtime (only the trusted in-process `ShadowHostCore`
   * key provider receives it). Returns null until running with ≥1 active
   * controller (there is nothing to serve before that).
   */
  /**
   * Renew the host lease BEFORE expiry using the persisted current-fence proof
   * (same epoch/leaseId — a pure expiry extension). Returns the renewed fence +
   * expiry so the caller can atomically update the live data service's authority.
   * Fail-closed: on any rejection the persisted lease is unchanged and the caller
   * must let the plane go read-only at expiry.
   */
  async renewLease(): Promise<{ fence: Fence; leaseExpiresAt: number } | null> {
    if (this.state !== 'running' || !this.identity || !this.record.fence) return null;
    const s = await this.opts.session.get();
    // 1. RESUME any durable pending intent first — replaying the identical renewalId
    //    is idempotent, so a crash between server acceptance and local persistence
    //    (or before either) is recovered here, never a lost transition.
    if (this.record.pendingLeaseRenewal) {
      const resumed = await this.commitRenewalIntent(s, this.record.pendingLeaseRenewal);
      if (typeof resumed === 'object') return resumed;
      if (resumed === 'fail-closed') { this.lastError = 'stale-authority-successor'; return null; }
      // 'retry-fresh' → the stale intent was cleared; mint a fresh one below.
    }
    // 2. Mint a FRESH durable intent (persisted BEFORE any network) then commit it
    //    through the atomic renew-and-store-transitions endpoint.
    const intent = await this.buildRenewalIntent(s);
    const committed = await this.commitRenewalIntent(s, intent);
    if (typeof committed === 'object') return committed;
    if (committed === 'fail-closed') { this.lastError = 'stale-authority-successor'; return null; }
    return this.record.fence && this.record.leaseExpiresAt !== null ? { fence: this.record.fence, leaseExpiresAt: this.record.leaseExpiresAt } : null;
  }

  /** Retry any durable pending renewal intent (startup / timer recovery). */
  async resumePendingRenewal(): Promise<{ fence: Fence; leaseExpiresAt: number } | null> {
    if (this.state !== 'running' || !this.identity || !this.record.pendingLeaseRenewal) return null;
    const s = await this.opts.session.get();
    const r = await this.commitRenewalIntent(s, this.record.pendingLeaseRenewal);
    if (typeof r === 'object') return r;
    if (r === 'fail-closed') this.lastError = 'stale-authority-successor';
    return null;
  }

  /**
   * Build + DURABLY persist a renewal intent (signed grants for every ACTIVE
   * controller + the exact requested expiry) BEFORE any network call. Grant ids/
   * nonces are stable per (renewalId, controller) so a replay is byte-identical.
   */
  private async buildRenewalIntent(s: Awaited<ReturnType<HostSessionProvider['get']>>): Promise<PendingLeaseRenewal> {
    const identity = this.identity!;
    const fence = this.record.fence!;
    const previousExpiresAt = this.record.leaseExpiresAt ?? this.now();
    const now = this.now();
    const requestedExpiresAt = Math.max(now + LEASE_RENEW_TTL_MS, previousExpiresAt + 1_000);
    const renewalId = `rn_${now}_${base64urlEncode(backend.randomBytes(9))}`;
    const active = this.record.controllers.filter((c) => c.status === 'active');
    const signedGrants: AuthorityTransitionGrantFields[] = [];
    for (const c of active) {
      const unsigned: Omit<AuthorityTransitionGrantFields, 'signature'> = {
        family: 'authority-transition-grant', v: 1,
        transitionId: `tr_${renewalId}_${c.controllerDeviceId}`,
        kind: 'lease-renewal',
        controllerDeviceId: c.controllerDeviceId,
        previousFence: fence, nextFence: fence,
        issuedAt: now, expiresAt: requestedExpiresAt,
        nonce: `n_${renewalId}_${c.controllerDeviceId}`,
        keyId: identity.signingKeyId,
      };
      signedGrants.push(await signAuthorityTransition(backend, identity.keys.signing.privateKey, unsigned));
    }
    const intent: PendingLeaseRenewal = {
      renewalId, previousFence: fence, previousExpiresAt, requestedExpiresAt, createdAt: now,
      signedGrants, activeControllerIds: active.map((c) => c.controllerDeviceId), status: 'pending',
    };
    this.record.pendingLeaseRenewal = intent;
    this.persist(); // DURABLE before the network — the crux of the fix.
    await this.crashAt('after-intent-before-server');
    return intent;
  }

  /**
   * Commit an intent through the ATOMIC endpoint. Returns the renewed authority on
   * success; `'fail-closed'` on a successor/stale fence (never resurrect); or
   * `'retry-fresh'` when the intent is stale but the fence is still current (the
   * caller mints a fresh intent). Transient/5xx throws (keep the intent for retry).
   */
  private async commitRenewalIntent(s: Awaited<ReturnType<HostSessionProvider['get']>>, intent: PendingLeaseRenewal): Promise<{ fence: Fence; leaseExpiresAt: number } | 'fail-closed' | 'retry-fresh'> {
    const identity = this.identity!;
    const client = await this.enrolledClient(s);
    const res = await client.requestEnrolled<{ fence: Fence; expiresAt: number; replayed: boolean }>(
      this.shadowSession(s), this.signer(identity),
      { method: 'POST', path: '/api/shadow/lease/renew-with-transitions', body: {
        scopeId: scopeFor(s.accountId), renewalId: intent.renewalId, currentFence: intent.previousFence,
        expectedCurrentExpiresAt: intent.previousExpiresAt, requestedExpiresAt: intent.requestedExpiresAt, grants: intent.signedGrants,
      } },
    );
    if (res.ok && res.json) {
      await this.crashAt('after-server-before-local');
      this.record.fence = res.json.fence;
      this.record.leaseExpiresAt = res.json.expiresAt;
      await this.crashAt('after-local-before-clear');
      this.record.pendingLeaseRenewal = undefined;
      this.persist();
      return { fence: res.json.fence, leaseExpiresAt: res.json.expiresAt };
    }
    // A successor/split-brain fence → fail closed; a stale-but-same-fence intent
    // (expiry in the past / not strictly increasing / concurrent) → mint fresh.
    if (res.status === 409 && /successor/i.test(res.error ?? '')) { this.record.pendingLeaseRenewal = undefined; this.persist(); return 'fail-closed'; }
    if (res.status === 400 || res.status === 409) { this.record.pendingLeaseRenewal = undefined; this.persist(); return 'retry-fresh'; }
    throw errStatus(res.error ?? 'renew-with-transitions failed', res.status);
  }

  private async crashAt(point: HostRenewalCrashPoint): Promise<void> {
    if (this.renewalCrashPoint === point) throw new Error(`crash-${point}`);
  }

  /** TEST-ONLY: inject a crash at a renewal-processing boundary. */
  debugSetRenewalCrashPointForTest(point: HostRenewalCrashPoint | null): void {
    this.renewalCrashPoint = point;
  }

  buildDataService(input: {
    rootDir: string;
    transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
    commandRegistry: ShadowCommandRegistry;
  }): ShadowHostDataService | null {
    const built = this.buildHostAndService(input);
    return built ? built.dataService : null;
  }

  private buildHostAndService(input: {
    rootDir: string;
    transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
    commandRegistry: ShadowCommandRegistry;
  }): { host: ShadowHostCore; dataService: ShadowHostDataService; fence: Fence } | null {
    if (this.state !== 'running' || !this.identity || !this.scopeKey || !this.record.fence) return null;
    const controller = this.record.controllers.find((c) => c.status === 'active');
    if (!controller) return null;
    const scopeKeyId = controller.keyId;
    const identity = this.identity;
    const keys = new StaticShadowKeyProvider(scopeKeyId, Buffer.from(this.scopeKey));
    const host = new ShadowHostCore(input.rootDir, keys);
    const dataService = new ShadowHostDataService({
      host, keys, scopeKeyId, fence: this.record.fence, leaseExpiresAt: this.record.leaseExpiresAt ?? this.now() + 300_000,
      // Phase 3B0 NOTE-2: seed the live authority with the CURRENT revoked set so a
      // freshly (re)built plane never serves a revoked controller — even before the
      // first renewal refresh.
      revokedControllerDeviceIds: this.revokedControllerDeviceIds(),
      session: async () => {
        const s = await this.opts.session.get();
        return { accountId: s.accountId, hostDeviceId: s.hostDeviceId, sessionToken: s.sessionToken, relayOrigin: s.relayOrigin };
      },
      signer: this.signer(identity),
      transport: input.transport,
      commandRegistry: input.commandRegistry,
      // Execution-time capability enforcement uses THIS host record, never the envelope.
      capabilitiesFor: (controllerDeviceId) => this.capabilitiesFor(controllerDeviceId),
    });
    return { host, dataService, fence: this.record.fence };
  }

  /**
   * Phase 3A2b1 Section B: build the FULL data plane — the accepted encrypted host
   * data/command service AND the all-project redacted `ShadowProductProjection`
   * SHARING one `ShadowHostCore` (same durable journal/index). The caller wires
   * `store.onDurableChange(projection.onDurableChange)`, runs `projection.start()`
   * once, and on account switch / signout calls `projection.close()` +
   * `store.onDurableChange(null)`. Returns null when the runtime is not enrolled/running.
   */
  buildDataPlane(input: {
    rootDir: string;
    transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
    commandRegistry: ShadowCommandRegistry;
    store: ProjectionStoreReader;
    log?: (message: string) => void;
  }): { dataService: ShadowHostDataService; projection: ShadowProductProjection } | null {
    const built = this.buildHostAndService(input);
    if (!built) return null;
    const projection = new ShadowProductProjection({
      host: built.host,
      fence: built.fence,
      store: input.store,
      now: () => this.now(),
      publish: () => built.dataService.publish().then(() => undefined),
      log: input.log,
    });
    return { dataService: built.dataService, projection };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async simpleSessionOp(op: 'deny' | 'cancel', sessionId: string, next: HostSessionRecord['status']): Promise<void> {
    const { s, identity } = await this.requireRunning();
    const client = await this.enrolledClient(s);
    const res = await client.requestEnrolled(this.shadowSession(s), this.signer(identity), {
      method: 'POST', path: `/api/shadow/enroll/${op}`, body: { sessionId },
    });
    if (!res.ok) throw errStatus(res.error ?? `${op} failed`, res.status);
    const sess = this.record.sessions.find((x) => x.sessionId === sessionId);
    if (sess) sess.status = next;
    this.persist();
  }

  private async requireRunning(): Promise<{ s: Awaited<ReturnType<HostSessionProvider['get']>>; identity: ShadowIdentity }> {
    if (this.state !== 'running' || !this.identity) throw errStatus('host runtime not running', 409);
    const s = await this.opts.session.get();
    return { s, identity: this.identity };
  }

  private requireFence(): Fence {
    if (!this.record.fence) throw errStatus('no active lease/fence', 409);
    return this.record.fence;
  }

  private requireScopeKey(): Uint8Array {
    if (!this.scopeKey) throw errStatus('no scope key', 409);
    return this.scopeKey;
  }

  private shadowSession(s: Awaited<ReturnType<HostSessionProvider['get']>>): ShadowSession {
    return { accountId: s.accountId, deviceId: s.hostDeviceId, sessionToken: s.sessionToken };
  }

  private signer(identity: ShadowIdentity): ShadowRequestSigner {
    return { keyId: identity.signingKeyId, sign: (bytes) => backend.sign(identity.keys.signing.privateKey, bytes) };
  }

  private async enrolledClient(s: Awaited<ReturnType<HostSessionProvider['get']>>): Promise<ShadowRequestClient> {
    return new ShadowRequestClient({
      baseUrl: s.relayOrigin,
      fetch: this.opts.transport.fetch,
      backend,
      now: this.now,
      randomNonce: this.opts.transport.randomNonce,
      allowInsecureLoopback: this.opts.transport.allowInsecureLoopback,
      timeoutMs: this.opts.transport.timeoutMs,
      maxResponseBytes: this.opts.transport.maxResponseBytes,
    });
  }

  private async loadOrCreateIdentity(): Promise<void> {
    if (this.record.identityCipher) {
      const json = this.opts.vault.decryptString(base64urlDecode(this.record.identityCipher));
      const blob = JSON.parse(json) as { signingSeed: string; signingPub: string; agreementSeed: string; agreementPub: string };
      const keys: ShadowIdentityKeys = {
        signing: { privateKey: base64urlDecode(blob.signingSeed), publicKey: base64urlDecode(blob.signingPub) },
        agreement: { privateKey: base64urlDecode(blob.agreementSeed), publicKey: base64urlDecode(blob.agreementPub) },
      };
      this.identity = await materializeIdentity(backend, this.record.hostDeviceId, keys);
    } else {
      const identity = await generateShadowIdentity(backend, this.record.hostDeviceId);
      this.identity = identity;
      const cipher = this.opts.vault.encryptString(JSON.stringify({
        signingSeed: base64urlEncode(identity.keys.signing.privateKey),
        signingPub: base64urlEncode(identity.keys.signing.publicKey),
        agreementSeed: base64urlEncode(identity.keys.agreement.privateKey),
        agreementPub: base64urlEncode(identity.keys.agreement.publicKey),
      }));
      this.record.identityCipher = base64urlEncode(cipher);
    }
    this.record.signingKeyId = this.identity.signingKeyId;
    this.record.agreementKeyId = this.identity.agreementKeyId;
    this.record.fingerprint = this.identity.signingKeyId;
    if (this.record.scopeKeyCipher) {
      // scopeKeyCipher stores vault(base64url(scopeKey)).
      this.scopeKey = base64urlDecode(this.opts.vault.decryptString(base64urlDecode(this.record.scopeKeyCipher)));
    }
  }

  private setScopeKey(key: Uint8Array): void {
    if (this.scopeKey) this.scopeKey.fill(0);
    this.scopeKey = key;
    this.record.scopeKeyCipher = base64urlEncode(this.opts.vault.encryptString(base64urlEncode(key)));
  }

  private async registerHost(s: Awaited<ReturnType<HostSessionProvider['get']>>): Promise<void> {
    const identity = this.identity!;
    const registrationSignature = base64urlEncode(await backend.sign(
      identity.keys.signing.privateKey,
      hostRegisterBytes(s.accountId, s.hostDeviceId, identity.signingPublicKey, identity.agreementPublicKey),
    ));
    // Bootstrap-host auth: session bearer + x-maestro-device-id, body self-signature.
    const client = new ShadowRequestClient({
      baseUrl: s.relayOrigin, fetch: this.opts.transport.fetch, backend, now: this.now,
      allowInsecureLoopback: this.opts.transport.allowInsecureLoopback, timeoutMs: this.opts.transport.timeoutMs,
      maxResponseBytes: this.opts.transport.maxResponseBytes, randomNonce: this.opts.transport.randomNonce,
    });
    const res = await client.requestBootstrap<{ fingerprint: string; signingKeyId: string; agreementKeyId: string }>(
      this.shadowSession(s),
      {
        method: 'POST', path: '/api/shadow/enroll/host-identity', includeDeviceId: true,
        body: {
          signingPublicKey: base64urlEncode(identity.signingPublicKey),
          agreementPublicKey: base64urlEncode(identity.agreementPublicKey),
          registrationSignature,
        },
      },
    );
    if (!res.ok) throw errStatus(res.error ?? 'host registration failed', res.status);
    this.record.registered = true;
  }

  private async acquireLease(s: Awaited<ReturnType<HostSessionProvider['get']>>): Promise<void> {
    const identity = this.identity!;
    const client = await this.enrolledClient(s);
    // On restart the same host RENEWS its lease by proving the persisted fence +
    // leaseId (same epoch); a first boot requests a fresh lease.
    // NOTE: the relay route reads `body.leaseId` (NOT `requestedLeaseId`); sending the
    // wrong field silently regenerates the leaseId on every same-fence renewal, which
    // would change the fence across restarts and break atomic lease-renewal recovery.
    const body = this.record.fence
      ? { scopeId: scopeFor(s.accountId), currentFence: this.record.fence, leaseId: this.record.fence.leaseId }
      : { scopeId: scopeFor(s.accountId) };
    const res = await client.requestEnrolled<{ fence: Fence; expiresAt: number }>(
      this.shadowSession(s),
      this.signer(identity),
      { method: 'POST', path: '/api/shadow/lease', body },
    );
    if (!res.ok || !res.json) throw errStatus(res.error ?? 'lease failed', res.status);
    this.record.fence = res.json.fence;
    this.record.leaseExpiresAt = res.json.expiresAt;
    if (!this.record.scopeKeyCipher) this.setScopeKey(backend.randomBytes(32));
  }

  private persist(): void {
    this.opts.persistence.save(this.record);
  }
}

interface RawPendingRequest {
  sessionId: string;
  controllerDeviceId: string;
  controllerSigningKeyId: string;
  controllerAgreementKeyId: string;
  signingPublicKey: string;
  agreementPublicKey: string;
  nonce: string;
  requestedAt: number;
  transcriptHash: string;
  relayOrigin: string;
  sessionExpiresAt: number;
  requestedCapabilities?: string[];
}

/** Public verifier pepper — must equal the server's ENROLLMENT_VERIFIER_PEPPER. */
function enrollmentPepper(): Uint8Array {
  return new TextEncoder().encode('maestro.shadow.enroll.verifier.pepper.v1');
}

/** Host-registration signing bytes — must match the server's HOST_REGISTER_DOMAIN input. */
function hostRegisterBytes(accountId: string, hostDeviceId: string, signingPub: Uint8Array, agreementPub: Uint8Array): Uint8Array {
  return structuredEncode(HOST_REGISTER_DOMAIN, [accountId, hostDeviceId, signingPub, agreementPub]);
}
