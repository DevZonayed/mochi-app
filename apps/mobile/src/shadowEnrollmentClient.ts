/**
 * shadowEnrollmentClient — Phase 3A2a Expo mobile controller enrollment runtime
 * core. A durable, crash-recoverable state machine that drives:
 *
 *   idle → parsing → confirming → requesting → awaiting-host → accepted → online
 *   terminal: expired | denied | cancelled | revoked | locked | error
 *
 * Security boundary (mobile):
 *  - Ed25519/X25519 device private seeds and the unwrapped account scope key live
 *    ONLY in the injected {@link SecureStoreAdapter} (expo-secure-store in-app,
 *    device-only / non-syncing). Never AsyncStorage, never the shadow SQLite DB.
 *  - Only PUBLIC grant metadata / cursors go to SQLite (the injected
 *    {@link EnrollmentMetaStore}).
 *  - On explicit server revocation or a registered-key 401, the runtime
 *    atomically marks revoked/locked, wipes the scope key + grant capability, and
 *    refuses further commands. Offline-without-observed-revocation stays truthful
 *    read-only (never fabricates authority).
 *
 * The crypto backend, SecureStore, SQLite meta store, signed transport and clock
 * are all injected, so the same core runs under Node crypto + node:sqlite in the
 * cross-tier E2E and under a Hermes @noble backend + expo-secure-store in-app.
 * No UI here (deferred to 3A2b).
 */
import {
  generateShadowIdentity,
  materializeIdentity,
  decodeEnrollmentBootstrap,
  encodeEnrollmentBootstrap,
  buildEnrollmentRequest,
  acceptEnrollmentGrant,
  unwrapRotatedScopeKey,
  verifyEnrollmentGrantSignature,
  type ShadowIdentity,
  type ShadowIdentityKeys,
  type EnrollmentBootstrap,
  type EnrollmentGrantMessage,
  type EnrollmentKeyMaterial,
} from '@maestro/realtime/shadowEnrollment';
import { canonicalizeCapabilities, type ShadowCapability } from '@maestro/realtime/shadowCapabilities';
import {
  base64urlEncode,
  base64urlDecode,
  structuredEncode,
  type ShadowCryptoBackend,
} from '@maestro/realtime/shadowCrypto';
import type { Fence } from '@maestro/realtime/shadowProtocol';
import type { ShadowStore } from './shadowClient';
import { ShadowControllerService, type ControllerSessionContext } from './shadowControllerService';
import {
  ShadowRequestClient,
  type ShadowSession,
  type ShadowRequestSigner,
  type ShadowTransportConfig,
} from '@maestro/realtime/shadowRequestClient';

/** Must match the server's CONTROLLER_POLL_DOMAIN in shadowEnrollmentService.ts. */
const CONTROLLER_POLL_DOMAIN = 'maestro.shadow.enroll.poll.v1';

export type EnrollmentState =
  | 'idle'
  | 'parsing'
  | 'confirming'
  | 'requesting'
  | 'awaiting-host'
  | 'accepted'
  | 'online'
  | 'expired'
  | 'denied'
  | 'cancelled'
  | 'revoked'
  | 'locked'
  | 'error';

const TERMINAL: ReadonlySet<EnrollmentState> = new Set(['expired', 'denied', 'cancelled', 'revoked', 'locked', 'error']);

/** expo-secure-store shape (device-only private key + scope key storage). */
export interface SecureStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Public grant metadata / cursor persistence (SQLite in-app). No secrets. */
export interface EnrollmentMetaStore {
  loadGrant(): Promise<StoredGrantMeta | null>;
  saveGrant(meta: StoredGrantMeta): Promise<void>;
  clearGrant(): Promise<void>;
}

export interface StoredGrantMeta {
  sessionId: string;
  controllerDeviceId: string;
  grantId: string;
  keyId: string;
  scopeKeyId: string;
  fence: Fence;
  expiresAt: number;
  transcriptHash: string; // base64url (public)
  hostSigningKeyId: string;
  hostSigningPublicKey: string; // base64url raw Ed25519 host signing pubkey (public trust root)
  /** base64url raw X25519 host AGREEMENT pubkey — persisted (Phase 3D1) so the screen
   * stream can derive its per-stream key after restart when the bootstrap is gone. */
  hostAgreementPublicKey?: string;
  /**
   * Conservative BOOTSTRAP lease expiry used as the initial
   * `ShadowExpectedAuthority.leaseExpiresAt` right after acceptance. This is NOT an
   * optimistic long window — `ShadowControllerService.reconcileAuthority()` replaces
   * it with the exact server-authoritative lease expiry on connect and on its
   * UI-independent renewal timer, and the runtime fail-closes read-only at expiry if
   * a valid renewal is unavailable.
   */
  leaseExpiresAt: number;
  status: 'active' | 'revoked';
  /**
   * Host-approved capability set (canonical). Integrity is NOT the plaintext copy: it
   * is re-verified on reload against `capabilityProof` (the ORIGINALLY-signed grant
   * fields) using the host signing key, so a tampered local copy fails closed.
   */
  approvedCapabilities?: ShadowCapability[];
  /**
   * The originally-verified grant's signature-bearing fields, IMMUTABLE across scope-key
   * rotation (rotation preserves capabilities), used to re-verify `approvedCapabilities`
   * on reload via `verifyEnrollmentGrantSignature`. Absent on a legacy grant (→ account.read).
   */
  capabilityProof?: { grantId: string; keyId: string; expiresAt: number; signedAt: number; signature: string };
}

/**
 * Short bootstrap window until the first server reconcile (`GET /api/shadow/authority`).
 * Kept small on purpose: a stale persisted authority fail-closes read-only rather than
 * trusting an optimistic window, and reconcile corrects it to the real lease.
 */
const CONTROLLER_BOOTSTRAP_LEASE_MS = 60_000;

export interface MobileSessionProvider {
  get(): Promise<{ accountId: string; controllerDeviceId: string; sessionToken: string; relayOrigin: string }>;
}

export interface ShadowMobileEnrollmentOptions {
  backend: ShadowCryptoBackend;
  secureStore: SecureStoreAdapter;
  metaStore: EnrollmentMetaStore;
  session: MobileSessionProvider;
  transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
  /** Allowed relay origins for the QR bootstrap (HTTPS in prod; loopback in tests/dev). */
  allowedOrigins: readonly string[];
  /** Capability set this controller REQUESTS at enrollment (signed into the request). Default account.read. */
  requestedCapabilities?: readonly ShadowCapability[];
  now?: () => number;
}

export interface EnrollmentStatus {
  state: EnrollmentState;
  accountId: string | null;
  controllerDeviceId: string | null;
  hostFingerprint: string | null;
  scopeKeyId: string | null;
  online: boolean;
  readonlyReason?: 'offline' | 'revoked' | 'locked' | 'awaiting';
  lastError?: string;
}

export interface AccountEnrollmentMac {
  hostDeviceId: string;
  name: string;
  platform: string;
  fingerprint: string;
  online: boolean;
  lastSeen: number;
  leaseExpiresAt: number | null;
}

function secureKeyIdentity(deviceId: string): string {
  return `maestro.shadow.identity.${deviceId}`;
}
/** Account (scopeId) + device scoped, so revocation wipes only this capability. */
function secureKeyScope(scopeId: string, controllerDeviceId: string): string {
  return `maestro.shadow.scopeKey.${controllerDeviceId}.${scopeId}`;
}

/** Controller enrollment runtime core. */
export class ShadowMobileEnrollmentRuntime {
  private state: EnrollmentState = 'idle';
  private lastError: string | undefined;
  private bootstrap: EnrollmentBootstrap | null = null;
  private presentedSecret: Uint8Array | null = null;
  private identity: ShadowIdentity | null = null;
  private grant: StoredGrantMeta | null = null;
  private scopeKey: Uint8Array | null = null;
  private online = false;
  /** B1-R1: grant/authority-change listeners. Fired on EVERY change that can affect a
   * dependent runtime's material/capabilities — restore, fresh accept, lease renewal,
   * revoke, and purge/clear — so the screen runtime re-attaches (or detaches) the client
   * exactly when the grant appears/changes/disappears (the flows where session/host don't). */
  private readonly grantListeners = new Set<() => void>();
  private readonly now: () => number;
  /**
   * Phase 3C3: the capability set this controller will REQUEST at enrollment. Defaults
   * to `opts.requestedCapabilities` (or the `account.read` floor). Mutable ONLY before a
   * request is in flight (idle/parsing/confirming), so the enrollment UI can offer an
   * explicit least-privilege choice (View only vs. selected Control actions). It is
   * canonicalised + signed into the request and re-checked (⊆ requested) at acceptance —
   * a mutation after `requesting` is refused, so it can never widen a live grant.
   */
  private requestedCaps: readonly ShadowCapability[] | undefined;

  constructor(private readonly opts: ShadowMobileEnrollmentOptions) {
    this.now = opts.now ?? Date.now;
    this.requestedCaps = opts.requestedCapabilities;
  }

  getState(): EnrollmentState {
    return this.state;
  }

  /**
   * Set the capability set to request on the NEXT enrollment. Allowed only before the
   * request is submitted (idle/parsing/confirming) — never mid-flight or post-grant, so
   * a live grant can never be silently widened. `account.read` (the read floor) is always
   * retained by the host regardless. Returns false (no-op) if it is too late to change.
   */
  setRequestedCapabilities(caps: readonly ShadowCapability[]): boolean {
    if (this.state !== 'idle' && this.state !== 'parsing' && this.state !== 'confirming') return false;
    this.requestedCaps = caps;
    return true;
  }

  status(): EnrollmentStatus {
    return {
      state: this.state,
      accountId: this.bootstrap?.accountId ?? this.grant?.fence.accountId ?? null,
      controllerDeviceId: this.grant?.controllerDeviceId ?? this.identity?.deviceId ?? null,
      hostFingerprint: this.bootstrap?.hostSigningKeyId ?? this.grant?.hostSigningKeyId ?? null,
      scopeKeyId: this.grant?.scopeKeyId ?? null,
      online: this.online,
      readonlyReason: this.readonlyReason(),
      lastError: this.lastError,
    };
  }

  private readonlyReason(): EnrollmentStatus['readonlyReason'] {
    if (this.state === 'revoked') return 'revoked';
    if (this.state === 'locked') return 'locked';
    if (this.state === 'awaiting-host' || this.state === 'requesting') return 'awaiting';
    if (this.state === 'online' && !this.online) return 'offline';
    return undefined;
  }

  /**
   * Rehydrate an existing enrollment from durable storage (crash recovery /
   * app relaunch). Restores online read-only truth without a server round-trip.
   */
  /** B1-R1: subscribe to grant/authority changes. Returns an unsubscribe fn. */
  subscribeGrant(cb: () => void): () => void {
    this.grantListeners.add(cb);
    return () => { this.grantListeners.delete(cb); };
  }

  /** Fire grant-change listeners (best-effort; a throwing listener never blocks others). */
  private notifyGrantChange(): void {
    for (const l of [...this.grantListeners]) { try { l(); } catch { /* */ } }
  }

  async restore(): Promise<EnrollmentStatus> {
    const meta = await this.opts.metaStore.loadGrant();
    if (!meta) return this.status();
    this.grant = meta;
    if (meta.status === 'revoked') {
      this.transition('revoked');
      return this.status();
    }
    // INTEGRITY: re-verify the persisted approved capabilities against the immutable
    // signed grant proof. A locally-tampered capability copy fails the host signature
    // → lock (fail closed, never a widened action).
    if ((await this.reverifyCapabilities(meta)) === null) {
      this.transition('locked');
      return this.status();
    }
    const raw = await this.opts.secureStore.getItemAsync(secureKeyScope(meta.fence.scopeId, meta.controllerDeviceId));
    if (!raw) {
      // Grant metadata without a scope key = unusable → locked (fail closed).
      this.transition('locked');
      return this.status();
    }
    this.scopeKey = base64urlDecode(raw);
    this.online = false;
    this.transition('online'); // online-but-offline read-only until a connect
    return this.status();
  }

  /**
   * Re-verify the persisted approved capability set against the immutable signed grant
   * proof (host signature over the bound transcript). Returns the canonical set, or
   * `null` if there is no active grant / it is revoked/locked / the persisted copy was
   * TAMPERED. A legacy grant with no proof falls back to the `account.read` read floor.
   */
  private async reverifyCapabilities(meta: StoredGrantMeta): Promise<ShadowCapability[] | null> {
    if (!meta.capabilityProof || !Array.isArray(meta.approvedCapabilities)) return ['account.read'];
    const canon = canonicalizeCapabilities(meta.approvedCapabilities);
    if (!canon.ok) return null;
    const grant: EnrollmentGrantMessage = {
      family: 'enrollment-grant', v: 1, fence: meta.fence, controllerDeviceId: meta.controllerDeviceId,
      grantId: meta.capabilityProof.grantId, keyId: meta.capabilityProof.keyId,
      expiresAt: meta.capabilityProof.expiresAt, signedAt: meta.capabilityProof.signedAt,
      capabilities: canon.capabilities, signature: meta.capabilityProof.signature,
    };
    let hostPub: Uint8Array;
    try { hostPub = base64urlDecode(meta.hostSigningPublicKey); } catch { return null; }
    const ok = await verifyEnrollmentGrantSignature(this.opts.backend, hostPub, grant, base64urlDecode(meta.transcriptHash));
    return ok ? canon.capabilities : null;
  }

  /**
   * The controller's current VERIFIED approved capability set for the action API, or
   * `null` if unavailable (no grant / revoked / locked / tampered). Production callers
   * MUST derive action permissions from this — never from an arbitrary array.
   */
  async verifiedApprovedCapabilities(): Promise<ShadowCapability[] | null> {
    if (!this.grant || this.state === 'revoked' || this.state === 'locked') return null;
    return this.reverifyCapabilities(this.grant);
  }

  /** Strictly parse + validate the versioned QR/deep-link bootstrap. */
  async parseBootstrap(raw: string): Promise<{ ok: true; hostFingerprint: string; expiresAt: number } | { ok: false; reason: string }> {
    this.transition('parsing');
    const s = await this.opts.session.get();
    const decoded = decodeEnrollmentBootstrap(raw, { allowedOrigins: this.opts.allowedOrigins, nowMs: this.now() });
    if (!decoded.ok) {
      this.fail(decoded.reason);
      return { ok: false, reason: decoded.reason };
    }
    // Reject an enrollment for a DIFFERENT account than the signed-in one.
    if (decoded.value.accountId !== s.accountId) {
      this.fail('wrong-account');
      return { ok: false, reason: 'wrong-account' };
    }
    this.bootstrap = decoded.value;
    this.transition('confirming');
    return { ok: true, hostFingerprint: decoded.value.hostSigningKeyId, expiresAt: decoded.value.expiresAt };
  }

  async listAccountMacs(): Promise<{ ok: true; macs: AccountEnrollmentMac[] } | { ok: false; reason: string }> {
    try {
      const s = await this.opts.session.get();
      const client = this.client(s.relayOrigin);
      const res = await client.requestBootstrap<{ macs: AccountEnrollmentMac[] }>(
        this.shadowSession(s),
        { method: 'GET', path: '/api/shadow/enroll/account/macs', includeDeviceId: true },
      );
      if (!res.ok || !res.json) return { ok: false, reason: res.error ?? `http-${res.status}` };
      return { ok: true, macs: Array.isArray(res.json.macs) ? res.json.macs : [] };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async startAccountEnrollment(hostDeviceId: string): Promise<{ ok: true; hostFingerprint: string; expiresAt: number } | { ok: false; reason: string }> {
    if (this.state !== 'idle' && this.state !== 'error' && this.state !== 'expired' && this.state !== 'denied' && this.state !== 'cancelled') {
      return { ok: false, reason: 'busy' };
    }
    this.transition('parsing');
    try {
      const s = await this.opts.session.get();
      const client = this.client(s.relayOrigin);
      const res = await client.requestBootstrap<{ bootstrap: EnrollmentBootstrap }>(
        this.shadowSession(s),
        {
          method: 'POST',
          path: '/api/shadow/enroll/account/challenge',
          includeDeviceId: true,
          body: { hostDeviceId, requestedCapabilities: this.requestedCaps ?? ['account.read'], relayOrigin: s.relayOrigin },
        },
      );
      if (!res.ok || !res.json?.bootstrap) {
        const reason = res.error ?? `http-${res.status}`;
        this.fail(reason);
        return { ok: false, reason };
      }
      const decoded = decodeEnrollmentBootstrap(encodeEnrollmentBootstrap(res.json.bootstrap), { allowedOrigins: this.opts.allowedOrigins, nowMs: this.now() });
      if (!decoded.ok) {
        this.fail(decoded.reason);
        return { ok: false, reason: decoded.reason };
      }
      if (decoded.value.accountId !== s.accountId || decoded.value.hostDeviceId !== hostDeviceId) {
        this.fail('challenge-mismatch');
        return { ok: false, reason: 'challenge-mismatch' };
      }
      this.bootstrap = decoded.value;
      this.transition('confirming');
      return { ok: true, hostFingerprint: decoded.value.hostSigningKeyId, expiresAt: decoded.value.expiresAt };
    } catch (e) {
      const reason = (e as Error).message;
      this.fail(reason);
      return { ok: false, reason };
    }
  }

  /**
   * After the operator confirms the SAS, submit the signed enrollment request +
   * one-time secret proof. idle→requesting→awaiting-host.
   */
  async requestEnrollment(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.state !== 'confirming' || !this.bootstrap) return { ok: false, reason: 'not-confirming' };
    this.transition('requesting');
    try {
      const s = await this.opts.session.get();
      const identity = await this.loadOrCreateIdentity(s.controllerDeviceId);
      const { request, presentedSecret } = await buildEnrollmentRequest(this.opts.backend, {
        controller: identity, bootstrap: this.bootstrap, nowMs: this.now(),
        requestedCapabilities: this.requestedCaps,
      });
      this.presentedSecret = presentedSecret;
      const client = this.client(s.relayOrigin);
      const res = await client.requestBootstrap<{ sessionId: string; controllerDeviceId: string; status: string }>(
        this.shadowSession(s),
        { method: 'POST', path: '/api/shadow/enroll/request', includeDeviceId: false, body: { sessionId: this.bootstrap.sessionId, request, presentedSecret: base64urlEncode(presentedSecret), idempotencyKey: request.nonce } },
      );
      if (!res.ok) {
        this.fail(res.error ?? 'request-denied');
        return { ok: false, reason: res.error ?? 'request-denied' };
      }
      this.transition('awaiting-host');
      return { ok: true };
    } catch (e) {
      this.fail((e as Error).message);
      return { ok: false, reason: (e as Error).message };
    }
  }

  /**
   * Poll enrollment status. On approval, verifies the host grant signature +
   * transcript + expected host fingerprint and unwraps the scope key into
   * SecureStore. Returns the resolved state.
   */
  async poll(): Promise<EnrollmentState> {
    if (this.state !== 'awaiting-host' || !this.bootstrap || !this.identity) return this.state;
    const s = await this.opts.session.get();
    const nowMs = this.now();
    const nonce = base64urlEncode(this.opts.backend.randomBytes(12));
    const signature = base64urlEncode(await this.opts.backend.sign(
      this.identity.keys.signing.privateKey,
      structuredEncode(CONTROLLER_POLL_DOMAIN, [s.accountId, this.bootstrap.sessionId, this.identity.deviceId, nonce, nowMs]),
    ));
    const client = this.client(s.relayOrigin);
    const res = await client.requestBootstrap<{ status: string; grant?: { grant: EnrollmentGrantMessage; keyMaterial: EnrollmentKeyMaterial } }>(
      this.shadowSession(s),
      { method: 'POST', path: '/api/shadow/enroll/poll', includeDeviceId: false, body: { sessionId: this.bootstrap.sessionId, controllerDeviceId: this.identity.deviceId, nonce, timestampMs: nowMs, signature } },
    );
    if (!res.ok || !res.json) {
      // Auth/registered-key denial after grant ⇒ locked; otherwise transient.
      if (res.status === 401) return this.lock('poll-unauthorized');
      return this.state;
    }
    const status = res.json.status;
    if (status === 'approved' && res.json.grant) {
      return this.acceptGrant(res.json.grant.grant, res.json.grant.keyMaterial);
    }
    if (status === 'denied') return this.terminal('denied');
    if (status === 'cancelled') return this.terminal('cancelled');
    if (status === 'revoked') return this.markRevoked();
    if (status === 'expired') return this.terminal('expired');
    return this.state; // still pending/consumed
  }

  private async acceptGrant(grant: EnrollmentGrantMessage, keyMaterial: EnrollmentKeyMaterial): Promise<EnrollmentState> {
    const bootstrap = this.bootstrap!;
    const identity = this.identity!;
    const transcriptHash = base64urlDecode(keyMaterial.transcriptHash);
    // Verify the host fingerprint matches the bootstrap before unwrap. `accepted.capabilities`
    // is the host-APPROVED set bound in (and verified from) the signed grant.
    const accepted = await acceptEnrollmentGrant(this.opts.backend, {
      controller: identity, bootstrap, grant, keyMaterial, transcriptHash, nowMs: this.now(),
    });
    if (!accepted.ok) {
      this.fail(`grant-${accepted.reason}`);
      return this.state;
    }
    // The controller further requires the approved set ⊆ what it originally requested
    // (defence-in-depth against a host granting an unrequested capability).
    const requestedCanon = canonicalizeCapabilities(this.requestedCaps);
    if (requestedCanon.ok) {
      const requested = new Set<ShadowCapability>(requestedCanon.capabilities);
      for (const c of accepted.capabilities) {
        if (c !== 'account.read' && !requested.has(c)) { this.fail('grant-capability-exceeds-requested'); return this.state; }
      }
    }
    const s = await this.opts.session.get();
    // Scope key → SecureStore ONLY. Public grant metadata → SQLite meta store.
    await this.opts.secureStore.setItemAsync(secureKeyScope(accepted.fence.scopeId, identity.deviceId), base64urlEncode(accepted.scopeKey));
    this.scopeKey = accepted.scopeKey;
    this.grant = {
      sessionId: bootstrap.sessionId,
      controllerDeviceId: identity.deviceId,
      grantId: grant.grantId,
      keyId: grant.keyId,
      scopeKeyId: accepted.scopeKeyId,
      fence: accepted.fence,
      expiresAt: grant.expiresAt,
      transcriptHash: keyMaterial.transcriptHash,
      hostSigningKeyId: bootstrap.hostSigningKeyId,
      hostSigningPublicKey: bootstrap.hostSigningPublicKey,
      hostAgreementPublicKey: bootstrap.hostAgreementPublicKey,
      leaseExpiresAt: this.now() + CONTROLLER_BOOTSTRAP_LEASE_MS,
      status: 'active',
      // Persist the approved set + proof ONLY when the grant was signed WITH a capability
      // field. A legacy grant (no field) reloads as the account.read floor — persisting a
      // proof would break reload re-verification (the signature covers no capability bytes).
      ...(grant.capabilities !== undefined ? {
        approvedCapabilities: accepted.capabilities,
        capabilityProof: { grantId: grant.grantId, keyId: grant.keyId, expiresAt: grant.expiresAt, signedAt: grant.signedAt, signature: grant.signature },
      } : {}),
    };
    await this.opts.metaStore.saveGrant(this.grant);
    void s;
    this.transition('accepted');
    return this.state;
  }

  /** Mark connected/online (after a successful controller connect). */
  setOnline(online: boolean): void {
    if (this.state === 'accepted' && online) this.transition('online');
    this.online = online && (this.state === 'online' || this.state === 'accepted');
  }

  /**
   * Re-poll after a rotation and unwrap the rotated scope key via the
   * authenticated AEAD path (the stale grant signature no longer matches the new
   * keyId; the wrap is host-authenticated). Returns true if a new key was applied.
   */
  async refreshRotatedScopeKey(): Promise<boolean> {
    if (!this.grant || !this.bootstrap || !this.identity || this.state === 'revoked' || this.state === 'locked') return false;
    const s = await this.opts.session.get();
    const nowMs = this.now();
    const nonce = base64urlEncode(this.opts.backend.randomBytes(12));
    const signature = base64urlEncode(await this.opts.backend.sign(
      this.identity.keys.signing.privateKey,
      structuredEncode(CONTROLLER_POLL_DOMAIN, [s.accountId, this.grant.sessionId, this.identity.deviceId, nonce, nowMs]),
    ));
    const client = this.client(s.relayOrigin);
    const res = await client.requestBootstrap<{ status: string; grant?: { grant: EnrollmentGrantMessage; keyMaterial: EnrollmentKeyMaterial } }>(
      this.shadowSession(s),
      { method: 'POST', path: '/api/shadow/enroll/poll', includeDeviceId: false, body: { sessionId: this.grant.sessionId, controllerDeviceId: this.identity.deviceId, nonce, timestampMs: nowMs, signature } },
    );
    if (!res.ok || !res.json) {
      // A revoked controller's registered key yields 401; any denial (401/403)
      // after enrollment means authority was lost → lock (fail closed).
      if (res.status === 401 || res.status === 403) { await this.markRevoked(); }
      return false;
    }
    if (res.json.status === 'revoked') { await this.markRevoked(); return false; }
    if (res.json.status !== 'approved' || !res.json.grant) return false;
    const { grant, keyMaterial } = res.json.grant;
    if (grant.keyId === this.grant.keyId) return false; // no rotation
    const unwrapped = await unwrapRotatedScopeKey(this.opts.backend, {
      controller: this.identity, bootstrap: this.bootstrap, grant, keyMaterial,
      transcriptHash: base64urlDecode(keyMaterial.transcriptHash), nowMs,
    });
    if (!unwrapped.ok) return false;
    await this.opts.secureStore.setItemAsync(secureKeyScope(unwrapped.fence.scopeId, this.identity.deviceId), base64urlEncode(unwrapped.scopeKey));
    if (this.scopeKey) this.scopeKey.fill(0);
    this.scopeKey = unwrapped.scopeKey;
    this.grant = { ...this.grant, grantId: grant.grantId, keyId: grant.keyId, scopeKeyId: unwrapped.scopeKeyId, expiresAt: grant.expiresAt };
    await this.opts.metaStore.saveGrant(this.grant);
    this.notifyGrantChange(); // B1-R1: lease/grant renewed (no state change) → re-attach with fresh material
    return true;
  }

  /**
   * Phase 3B0 NOTE-1: DURABLY purge this enrollment for a sign-out / account /
   * host switch — delete the SecureStore scope key AND clear the persisted public
   * grant metadata, then drop all in-memory enrollment truth. Idempotent and
   * fail-closed: it resolves the persisted grant (if not already loaded) to target
   * the exact scope-key handle; any storage failure REJECTS so the caller blocks
   * new-controller activation rather than leaving prior-account state readable.
   * No network, safe to call when never enrolled / partially initialized.
   */
  async purgeDurable(): Promise<void> {
    const handles = await this.scopeKeyHandlesForPurge();
    const reasons: string[] = [];
    // AGGREGATE: attempt every destructive stage; never skip after the first failure.
    for (const h of handles) {
      try { await this.deleteSecureItem(h); } catch (e) { reasons.push(`scopeKey: ${(e as Error)?.message ?? e}`); }
    }
    try { await this.clearGrantMeta(); } catch (e) { reasons.push(`grant: ${(e as Error)?.message ?? e}`); }
    if (reasons.length > 0) throw new Error(`purgeDurable incomplete: ${reasons.join('; ')}`);
  }

  // ── O-1 granular purge primitives (composed by the durable purge gate) ──

  /** The SecureStore injected into this runtime — for the durable purge tombstone gate. */
  secureStoreRef(): SecureStoreAdapter { return this.opts.secureStore; }

  /** The persisted public grant metadata (for verifying it is gone), or null. */
  async loadGrantMeta(): Promise<StoredGrantMeta | null> { return this.opts.metaStore.loadGrant(); }

  /**
   * The exact SecureStore scope-key handles to erase for the current/persisted
   * grant (empty when never enrolled). Captured BEFORE a purge so a retry can
   * target them even after the grant meta is cleared.
   */
  async scopeKeyHandlesForPurge(): Promise<string[]> {
    let meta = this.grant;
    if (!meta) { try { meta = await this.opts.metaStore.loadGrant(); } catch { meta = null; } }
    return meta ? [secureKeyScope(meta.fence.scopeId, meta.controllerDeviceId)] : [];
  }

  /** Erase one SecureStore item (a scope-key handle). */
  async deleteSecureItem(key: string): Promise<void> { await this.opts.secureStore.deleteItemAsync(key); }

  /**
   * Clear the durable public grant metadata + drop all in-memory enrollment truth.
   * Zeroes the in-memory scope key FIRST (idempotent) so even a `clearGrant` throw
   * leaves no in-memory secret. The device identity keypair is per-device, not
   * per-account, so it is intentionally retained across an account/host switch.
   */
  async clearGrantMeta(): Promise<void> {
    if (this.scopeKey) { this.scopeKey.fill(0); this.scopeKey = null; }
    await this.opts.metaStore.clearGrant();
    this.grant = null;
    this.bootstrap = null;
    this.presentedSecret = null;
    this.online = false;
    this.lastError = undefined;
    this.state = 'idle';
    this.notifyGrantChange(); // B1-R1: grant cleared (purge/logout) → dependents detach + zero
  }

  /** Explicit server revocation observed: atomically lock + wipe scope key. */
  async markRevoked(): Promise<EnrollmentState> {
    await this.wipeScopeKey();
    if (this.grant) { this.grant.status = 'revoked'; await this.opts.metaStore.saveGrant(this.grant); }
    this.online = false;
    this.transition('revoked');
    return this.state;
  }

  private async lock(reason: string): Promise<EnrollmentState> {
    await this.wipeScopeKey();
    this.lastError = reason;
    this.online = false;
    this.transition('locked');
    return this.state;
  }

  /** The unwrapped scope key (throws unless online & authorized). */
  getScopeKey(): Uint8Array {
    if (this.state !== 'online' && this.state !== 'accepted') throw new Error('scope key unavailable in state ' + this.state);
    if (!this.scopeKey) throw new Error('no scope key');
    return this.scopeKey;
  }

  /** Whether a command may be issued right now (never while offline/awaiting/revoked). */
  canIssueCommand(): boolean {
    return this.state === 'online' && this.online && !!this.scopeKey;
  }

  private async wipeScopeKey(): Promise<void> {
    const scopeId = this.grant?.fence.scopeId ?? this.bootstrap?.sessionId;
    if (this.grant) await this.opts.secureStore.deleteItemAsync(secureKeyScope(this.grant.fence.scopeId, this.grant.controllerDeviceId));
    if (this.scopeKey) this.scopeKey.fill(0);
    this.scopeKey = null;
    void scopeId;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadOrCreateIdentity(deviceId: string): Promise<ShadowIdentity> {
    if (this.identity && this.identity.deviceId === deviceId) return this.identity;
    const raw = await this.opts.secureStore.getItemAsync(secureKeyIdentity(deviceId));
    if (raw) {
      const blob = JSON.parse(raw) as { signingSeed: string; signingPub: string; agreementSeed: string; agreementPub: string };
      const keys: ShadowIdentityKeys = {
        signing: { privateKey: base64urlDecode(blob.signingSeed), publicKey: base64urlDecode(blob.signingPub) },
        agreement: { privateKey: base64urlDecode(blob.agreementSeed), publicKey: base64urlDecode(blob.agreementPub) },
      };
      this.identity = await materializeIdentity(this.opts.backend, deviceId, keys);
      return this.identity;
    }
    const identity = await generateShadowIdentity(this.opts.backend, deviceId);
    await this.opts.secureStore.setItemAsync(secureKeyIdentity(deviceId), JSON.stringify({
      signingSeed: base64urlEncode(identity.keys.signing.privateKey),
      signingPub: base64urlEncode(identity.keys.signing.publicKey),
      agreementSeed: base64urlEncode(identity.keys.agreement.privateKey),
      agreementPub: base64urlEncode(identity.keys.agreement.publicKey),
    }));
    this.identity = identity;
    return identity;
  }

  private client(relayOrigin: string): ShadowRequestClient {
    return new ShadowRequestClient({
      baseUrl: relayOrigin, fetch: this.opts.transport.fetch, backend: this.opts.backend, now: this.now,
      randomNonce: this.opts.transport.randomNonce, allowInsecureLoopback: this.opts.transport.allowInsecureLoopback,
      timeoutMs: this.opts.transport.timeoutMs, maxResponseBytes: this.opts.transport.maxResponseBytes,
    });
  }

  private shadowSession(s: { accountId: string; controllerDeviceId: string; sessionToken: string }): ShadowSession {
    return { accountId: s.accountId, deviceId: s.controllerDeviceId, sessionToken: s.sessionToken };
  }

  /** Enrolled-controller signer (for connect/command/cursor routes after grant). */
  enrolledSigner(): ShadowRequestSigner {
    if (!this.identity) throw new Error('no identity');
    const key = this.identity.keys.signing.privateKey;
    return { keyId: this.identity.signingKeyId, sign: (bytes) => this.opts.backend.sign(key, bytes) };
  }

  /**
   * Phase 3D1: the material a `ScreenStreamClient` needs, resolved from the enrolled
   * identity + active grant. The raw agreement/signing private-key bytes are returned
   * ONLY so the caller can hand them straight to the pure `ScreenStreamClient`/
   * `deriveScreenStreamKey` — they must never be copied into React state, logs, or
   * AsyncStorage (mirrors how the scope key is handed to the controller service).
   * Returns null when there is no usable grant (unenrolled / revoked / locked / no
   * persisted host agreement key). Loads the enrolled identity on demand after a
   * cold restart (restore() only reloads the grant).
   */
  async screenClientMaterial(): Promise<{
    controllerAgreementPrivate: Uint8Array;
    hostAgreementPublic: Uint8Array;
    controllerSigningPrivate: Uint8Array;
    controllerSigningKeyId: string;
    hostSigningPublic: Uint8Array;
    identity: { accountId: string; hostDeviceId: string; controllerDeviceId: string; grantId: string; scopeId: string; epoch: number; leaseId: string; leaseExpiresAt: number };
  } | null> {
    const grant = this.grant;
    if (!grant || this.state === 'revoked' || this.state === 'locked' || !grant.hostAgreementPublicKey) return null;
    if (!this.identity) {
      try { await this.loadOrCreateIdentity(grant.controllerDeviceId); } catch { return null; }
    }
    if (!this.identity) return null;
    let hostAgreementPublic: Uint8Array;
    let hostSigningPublic: Uint8Array;
    try {
      hostAgreementPublic = base64urlDecode(grant.hostAgreementPublicKey);
      hostSigningPublic = base64urlDecode(grant.hostSigningPublicKey);
    } catch { return null; }
    return {
      controllerAgreementPrivate: this.identity.keys.agreement.privateKey,
      hostAgreementPublic,
      controllerSigningPrivate: this.identity.keys.signing.privateKey,
      controllerSigningKeyId: this.identity.signingKeyId,
      hostSigningPublic,
      identity: {
        accountId: grant.fence.accountId, hostDeviceId: grant.fence.hostDeviceId, controllerDeviceId: grant.controllerDeviceId,
        grantId: grant.grantId, scopeId: grant.fence.scopeId, epoch: grant.fence.epoch, leaseId: grant.fence.leaseId, leaseExpiresAt: grant.leaseExpiresAt,
      },
    };
  }

  /**
   * Compose a production `ShadowControllerService` (a real `ShadowMobileClient`
   * over the durable store) from this accepted grant + in-memory scope key +
   * controller identity. The scope key stays encapsulated (only the durable
   * client's crypto adapter receives it). Returns null unless an active grant +
   * scope key are present.
   */
  buildControllerService(input: {
    store: ShadowStore;
    session: () => Promise<ControllerSessionContext>;
    transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
  }): ShadowControllerService | null {
    if (!this.grant || !this.scopeKey || !this.identity || this.state === 'revoked' || this.state === 'locked') return null;
    return new ShadowControllerService({
      backend: this.opts.backend,
      store: input.store,
      scopeKey: this.scopeKey,
      scopeKeyId: this.grant.scopeKeyId,
      expectedAuthority: { fence: this.grant.fence, controllerDeviceId: this.grant.controllerDeviceId, leaseExpiresAt: this.grant.leaseExpiresAt },
      hostSigningPublicKey: base64urlDecode(this.grant.hostSigningPublicKey),
      hostSigningKeyId: this.grant.hostSigningKeyId,
      controllerSigner: this.enrolledSigner(),
      session: input.session,
      transport: input.transport,
    });
  }

  /** Public grant summary (no scope key) for opening the durable store. */
  grantSummary(): { controllerDeviceId: string; hostDeviceId: string; fence: Fence; leaseExpiresAt: number } | null {
    if (!this.grant) return null;
    return { controllerDeviceId: this.grant.controllerDeviceId, hostDeviceId: this.grant.fence.hostDeviceId, fence: this.grant.fence, leaseExpiresAt: this.grant.leaseExpiresAt };
  }

  private terminal(next: EnrollmentState): EnrollmentState {
    this.transition(next);
    return this.state;
  }

  private fail(reason: string): void {
    this.lastError = reason;
    // A strict-parse/expiry failure lands on the specific terminal state.
    if (reason === 'expired') this.transition('expired');
    else this.transition('error');
  }

  private transition(next: EnrollmentState): void {
    if (TERMINAL.has(this.state) && this.state !== next && !(this.state === 'error' && next === 'error')) {
      // Once terminal, stay terminal (revoked/locked are sticky) — except we allow
      // re-parsing from a clean idle via reset().
      if (this.state === 'revoked' || this.state === 'locked') return;
    }
    const changed = this.state !== next;
    this.state = next;
    if (changed) this.notifyGrantChange(); // B1-R1: state change → dependents re-evaluate
  }

  /** Reset to idle for a fresh enrollment (keeps device identity for re-enrollment). */
  async reset(): Promise<void> {
    this.bootstrap = null;
    if (this.presentedSecret) this.presentedSecret.fill(0);
    this.presentedSecret = null;
    this.online = false;
    this.state = 'idle';
    this.lastError = undefined;
  }
}
