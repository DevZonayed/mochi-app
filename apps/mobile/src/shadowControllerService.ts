/**
 * shadowControllerService — Phase 3A2a production MOBILE durable controller
 * runtime. An ACCEPTED enrollment grant (fence + scope key) drives a REAL
 * `ShadowMobileClient` over the durable `ExpoSQLiteShadowStore`:
 *
 *   - a real crypto adapter decrypts host state events with the HKDF-derived
 *     event ring (shadowDataCodec) and applies them via `ShadowMobileClient`,
 *     persisting entities + cursor in SQLite (restart-safe);
 *   - a signed relay adapter (controller identity) connects, catches up events,
 *     submits the cursor, posts encrypted commands, and polls host ACKs;
 *   - a control-message verifier authenticates host ACKs by their command-ack MAC.
 *
 * AUTHORITY / LEASE (3A2a re-review finding 2). The controller does NOT trust a
 * fixed optimistic window. On connect and on a UI-independent timer it RECONCILES
 * the server-authoritative lease via `GET /api/shadow/authority`: a same-fence
 * expiry extension is persisted transactionally to SQLite (and mirrored into the
 * client's expected authority); an epoch/leaseId change is NOT trusted on the
 * relay's word (it requires a host-signed transition) and the plane stays offline
 * read-only until one arrives. At/after expiry with no valid renewal the runtime
 * is fail-closed read-only.
 *
 * The scope key lives only in memory here (loaded from SecureStore by the
 * factory); no private/scope plaintext touches SQLite, logs, or the network. On
 * 401/403 the runtime atomically stops, locks + wipes the scope key + HKDF rings.
 */
import {
  ShadowMobileClient,
  type ShadowStore,
  type ShadowExpectedAuthority,
  type ShadowCryptoAdapter,
  type ShadowEntity,
} from './shadowClient';
import type { Fence, ShadowStateEvent, HostCommandAck, CommandLifecycleState } from '@maestro/realtime';
import {
  ShadowRequestClient,
  type ShadowRequestSigner,
  type ShadowTransportConfig,
} from '@maestro/realtime/shadowRequestClient';
import { base64urlEncode, type ShadowCryptoBackend } from '@maestro/realtime/shadowCrypto';
import { isValidIdempotencyKey } from './shadowActionIdempotency';
import {
  deriveScopeKeyring, type ScopeKeyring,
  openEventPayload,
  sealCommandEnvelope,
  openCommandAck,
  verifyCommandAck,
} from '@maestro/realtime/shadowDataCodec';
import { verifyAuthorityTransitionSignature, type AuthorityTransitionGrantFields } from '@maestro/realtime/shadowAuthorityTransition';

async function sha256Digest(backend: ShadowCryptoBackend, bytes: Uint8Array): Promise<string> {
  return `sha256:${base64urlEncode(await backend.sha256(bytes))}`;
}

function sameFence(a: Fence, b: Fence): boolean {
  return a.accountId === b.accountId && a.scopeId === b.scopeId && a.hostDeviceId === b.hostDeviceId && a.epoch === b.epoch && a.leaseId === b.leaseId;
}

/** Allowed clock skew when treating a reconciled lease as still valid. */
const LEASE_SKEW_MS = 1_000;

export interface ControllerSessionContext {
  accountId: string;
  controllerDeviceId: string;
  sessionToken: string;
  relayOrigin: string;
}

export interface ShadowControllerServiceOptions {
  backend: ShadowCryptoBackend;
  store: ShadowStore;
  /** Scope key (32 bytes) — kept in memory only. */
  scopeKey: Uint8Array;
  scopeKeyId: string;
  expectedAuthority: ShadowExpectedAuthority;
  /** Enrollment host signing trust root — verifies host-signed lease transitions. */
  hostSigningPublicKey: Uint8Array;
  hostSigningKeyId: string;
  controllerSigner: ShadowRequestSigner;
  session: () => Promise<ControllerSessionContext>;
  transport: Pick<ShadowTransportConfig, 'fetch'> & Partial<Pick<ShadowTransportConfig, 'allowInsecureLoopback' | 'timeoutMs' | 'maxResponseBytes' | 'randomNonce'>>;
  now?: () => number;
  /** Optional scheduler hook (defaults to global setInterval/clearInterval). */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export type ControllerServiceState = 'idle' | 'online' | 'offline' | 'locked';

export interface ControllerServiceStatus {
  state: ControllerServiceState;
  online: boolean;
  lastSeq: number | null;
  entities: number;
  locked: boolean;
  leaseExpiresAt: number;
  lastError?: string;
}

interface ConnectResponse {
  decision: { decision: string; fromSeq?: number; toSeq?: number; reason?: string };
  events?: unknown[];
}

/** Production durable controller runtime. */
export class ShadowControllerService {
  private readonly client: ShadowMobileClient;
  private readonly backend: ShadowCryptoBackend;
  private readonly now: () => number;
  private scopeKey: Uint8Array | null;
  private readonly keyRing = new Map<string, Uint8Array>();
  private readonly codecRings = new Map<string, ScopeKeyring>();
  private currentKeyId: string;
  private expected: ShadowExpectedAuthority;
  private state: ControllerServiceState = 'idle';
  private lastError: string | undefined;
  private reconcileTimer: unknown = null;
  /** Last server-reported lease expiry (observability; the chain authority gates events). */
  private serverLeaseExpiresAt = 0;

  constructor(private readonly opts: ShadowControllerServiceOptions) {
    this.backend = opts.backend;
    this.now = opts.now ?? Date.now;
    this.scopeKey = opts.scopeKey;
    this.currentKeyId = opts.scopeKeyId;
    this.expected = { ...opts.expectedAuthority, fence: { ...opts.expectedAuthority.fence } };
    this.keyRing.set(opts.scopeKeyId, opts.scopeKey);
    const crypto: ShadowCryptoAdapter = {
      decryptEvent: async (event: ShadowStateEvent) => {
        const key = this.keyRing.get(event.keyId);
        if (!key) return null;
        const keyring = await this.keyringFor(event.keyId, key);
        const payload = await openEventPayload(this.backend, keyring, event);
        if (payload === null || payload === undefined) return null;
        return { event, payload };
      },
      digest: async (bytes: Uint8Array) => sha256Digest(this.backend, bytes),
    };
    this.client = new ShadowMobileClient({
      controllerDeviceId: this.expected.controllerDeviceId,
      hostDeviceId: this.expected.fence.hostDeviceId,
      expectedAuthority: this.expected,
      store: opts.store,
      now: this.now,
      crypto,
      controlMessageVerifier: {
        verifyControlMessage: async ({ family, message }) => {
          if (family !== 'command-ack') return { ok: false, reason: 'unsupported-control-family' };
          if (!this.scopeKey) return { ok: false, reason: 'locked' };
          const keyring = await this.keyringFor(this.currentKeyId, this.scopeKey);
          const ok = await verifyCommandAck(this.backend, keyring, message as HostCommandAck);
          return ok ? { ok: true } : { ok: false, reason: 'bad-ack-signature' };
        },
      },
      // Real host-signature verifier bound to the enrollment host trust root — the
      // ONLY way an authority (lease) transition can advance the durable chain.
      authorityTransitionVerifier: {
        verifyAuthorityTransition: async ({ grant }) => {
          const ok = await verifyAuthorityTransitionSignature(
            this.backend,
            { hostSigningPublicKey: opts.hostSigningPublicKey, hostSigningKeyId: opts.hostSigningKeyId },
            grant as unknown as AuthorityTransitionGrantFields,
          );
          return ok ? { ok: true } : { ok: false, reason: 'bad-host-signature' };
        },
      },
    });
  }

  /** Load persisted state (cursor/commands/entities) without a network round-trip. */
  async load(): Promise<ControllerServiceStatus> {
    await this.client.load();
    // Reconcile the mutable authority to the DURABLE persisted lease (restart-safe).
    const persisted = this.client.read().expectedAuthority;
    if (persisted && sameFence(persisted.fence, this.expected.fence)) this.expected = { ...persisted, fence: { ...persisted.fence } };
    if (this.state === 'idle') this.state = 'offline';
    return this.status();
  }

  status(): ControllerServiceStatus {
    const s = this.client.read();
    return {
      state: this.state,
      online: s.connection === 'online',
      lastSeq: s.cursor?.lastSeq ?? null,
      entities: s.entities.length,
      locked: this.state === 'locked',
      leaseExpiresAt: this.expected.leaseExpiresAt,
      lastError: this.lastError,
    };
  }

  private fence(): Fence {
    return this.expected.fence;
  }

  private requireScopeKey(): Uint8Array {
    if (!this.scopeKey) throw new Error('scope key wiped (locked)');
    return this.scopeKey;
  }

  private async keyringFor(keyId: string, key: Uint8Array): Promise<ScopeKeyring> {
    let kr = this.codecRings.get(keyId);
    if (!kr) {
      kr = await deriveScopeKeyring(this.backend, key, { accountId: this.expected.fence.accountId, scopeId: this.expected.fence.scopeId, keyId });
      this.codecRings.set(keyId, kr);
    }
    return kr;
  }

  /** Add a rotated scope key to the bounded key ring and make it current. */
  applyRotatedScopeKey(scopeKeyId: string, scopeKey: Uint8Array): void {
    this.scopeKey = scopeKey;
    this.currentKeyId = scopeKeyId;
    this.keyRing.set(scopeKeyId, scopeKey);
    // Bound the ring: keep at most the 4 most-recent keys.
    while (this.keyRing.size > 4) {
      const oldest = this.keyRing.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === scopeKeyId) break;
      this.keyRing.delete(oldest);
      this.codecRings.get(oldest)?.dispose();
      this.codecRings.delete(oldest);
    }
  }

  isLocked(): boolean {
    return this.state === 'locked';
  }

  /** True once the reconciled lease has expired (fail-closed read-only). Public so the
      production action gate can flip to "unavailable" the instant the lease lapses. */
  leaseExpired(): boolean {
    return this.now() >= this.expected.leaseExpiresAt + LEASE_SKEW_MS;
  }

  /**
   * Connect + catch up: reconcile the server lease, pull the event delta, apply
   * each, advance the cursor, then poll host ACKs. Returns the number of events
   * applied.
   */
  async connect(): Promise<number> {
    if (this.isLocked()) throw new Error('controller locked');
    await this.client.load();
    // Apply any pending host-signed lease-renewal transition FIRST so the durable
    // authority (and its expiry) is current before we verify + operate.
    await this.fetchAndApplyTransitions();
    await this.reconcileAuthority();
    if (this.isLocked()) throw new Error('controller locked');
    const applied = await this.pollEvents();
    await this.pollAcks();
    if (!this.isLocked() && !this.leaseExpired()) {
      await this.client.setOnline(true);
      this.state = 'online';
    } else if (!this.isLocked()) {
      await this.client.setOnline(false);
      this.state = 'offline';
    }
    this.notifyProjectionChange();
    return applied;
  }

  /**
   * Reconcile the server-authoritative lease (verify-only, chain-safe). The durable
   * authority is CHAIN-VALIDATED (`sameExpectedAuthority` binds `leaseExpiresAt`), so
   * the expiry cannot be rewritten without a HOST-SIGNED `lease-rotation` transition —
   * this method therefore never invents unsigned authority. It:
   *   - confirms the server still reports the SAME fence (a changed epoch/leaseId
   *     must arrive as a signed transition, so a mismatch fail-closes read-only);
   *   - confirms the server lease is live and covers the mobile's granted window.
   * The host keeps the SERVER lease alive (renewal), so this verify passes across
   * renewals; the mobile fail-closes at its real granted expiry rather than trusting
   * an optimistic window. Returns true if the current authority is usable.
   */
  async reconcileAuthority(): Promise<boolean> {
    if (this.isLocked()) return false;
    const res = await this.request<{ fence: Fence; expiresAt: number }>('GET', `/api/shadow/authority?scopeId=${encodeURIComponent(this.fence().scopeId)}`, undefined);
    if (!res.ok) { this.handleTransportError(res.status, 'authority'); return false; }
    const authority = res.json;
    if (!authority || typeof authority.expiresAt !== 'number' || !Number.isSafeInteger(authority.expiresAt)) { this.lastError = 'authority-malformed'; return false; }
    if (!sameFence(authority.fence, this.expected.fence)) {
      // Epoch/leaseId rotation must be delivered as a HOST-SIGNED lease-rotation
      // transition, not the relay's word — fail closed until one is consumed.
      this.lastError = 'authority-fence-changed';
      await this.client.setOnline(false);
      if (this.state !== 'locked') this.state = 'offline';
      return false;
    }
    // Server lease itself expired → fail-closed (host has not renewed).
    if (this.now() >= authority.expiresAt) { this.lastError = 'server-lease-expired'; return false; }
    this.serverLeaseExpiresAt = authority.expiresAt;
    return !this.leaseExpired();
  }

  /**
   * Consume a HOST-SIGNED authority transition (`lease-renewal` / `lease-rotation`)
   * to advance the durable authority within the chain — the ONLY sanctioned way to
   * change `leaseExpiresAt`. Delegates to the client's real verifier +
   * `transitionAuthority`; on success the mobile's expected authority + persisted
   * SQLite authority advance transactionally.
   */
  async applyAuthorityTransition(grant: unknown): Promise<boolean> {
    try {
      const ok = await this.client.transitionAuthority(grant);
      if (!ok) { this.lastError = 'transition-rejected'; return false; }
      const persisted = this.client.read().expectedAuthority;
      if (persisted) this.expected = { ...persisted, fence: { ...persisted.fence } };
      return true;
    } catch (e) { this.lastError = `transition-error:${(e as Error)?.message ?? 'unknown'}`; return false; }
  }

  /**
   * Fetch pending host-signed transitions from the relay, cryptographically verify +
   * apply each (persisting the increased expiry), and consume them so they are not
   * re-delivered. An expired-old-authority controller can still fetch its renewal —
   * the host signature, not the relay, is the authority. Returns the count applied.
   */
  async fetchAndApplyTransitions(): Promise<number> {
    if (this.isLocked()) return 0;
    const res = await this.request<{ grants: unknown[] }>('GET', `/api/shadow/transitions?scopeId=${encodeURIComponent(this.fence().scopeId)}`, undefined);
    if (!res.ok) { this.handleTransportError(res.status, 'transitions'); return 0; }
    let applied = 0;
    for (const grant of res.json?.grants ?? []) {
      const ok = await this.applyAuthorityTransition(grant);
      const transitionId = (grant as { transitionId?: string }).transitionId;
      if (ok && transitionId) {
        applied += 1;
        // Best-effort consume; re-delivery is harmless (transitionAuthority is replay-safe).
        const done = await this.request('POST', `/api/shadow/transitions/${encodeURIComponent(transitionId)}/consume`, { scopeId: this.fence().scopeId });
        if (!done.ok && (done.status === 401 || done.status === 403)) this.lock(`transitions-denied-${done.status}`);
      }
    }
    return applied;
  }

  /** Start UI-independent periodic lease reconciliation + event polling. */
  startAutoReconcile(intervalMs = 10_000): void {
    if (this.reconcileTimer || this.isLocked()) return;
    const set = this.opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.reconcileTimer = set(() => { void this.tick(); }, intervalMs);
  }

  stopAutoReconcile(): void {
    if (!this.reconcileTimer) return;
    const clear = this.opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  private async tick(): Promise<void> {
    if (this.isLocked()) { this.stopAutoReconcile(); return; }
    try { await this.fetchAndApplyTransitions(); await this.reconcileAuthority(); await this.pollEvents(); await this.pollAcks(); }
    catch { /* transient; next tick retries */ }
  }

  /** Poll the event stream (connect delta) and durably apply. */
  async pollEvents(): Promise<number> {
    const s = this.client.read();
    const lastSeq = s.cursor?.lastSeq ?? 0;
    const hello = {
      protocolVersion: 1 as const,
      controllerDeviceId: this.expected.controllerDeviceId,
      hostDeviceId: this.fence().hostDeviceId,
      epoch: this.fence().epoch,
      lastSeq,
      collectionDigests: {},
    };
    const res = await this.request<ConnectResponse>('POST', '/api/shadow/connect', { hello });
    if (!res.ok) return this.handleTransportError(res.status, 'connect');
    const events = res.json?.events ?? [];
    let applied = 0;
    for (const wire of events) {
      const result = await this.client.applyWire(wire);
      if (result.status === 'applied') applied += 1;
    }
    const cursor = this.client.read().cursor;
    if (cursor && cursor.lastSeq > lastSeq) {
      await this.submitCursor(cursor.lastSeq, cursor.lastEventId ?? undefined, cursor.lastDigest ?? undefined);
    }
    return applied;
  }

  private async submitCursor(lastSeq: number, lastEventId?: string, lastDigest?: string): Promise<void> {
    const res = await this.request('POST', '/api/shadow/cursor', { fence: this.fence(), lastSeq, lastEventId, lastDigest });
    if (!res.ok && (res.status === 401 || res.status === 403)) this.lock('cursor-denied');
  }

  /** Poll host ACKs, verify + apply, and drive the command lifecycle to completion. */
  async pollAcks(): Promise<void> {
    const fenceParam = encodeURIComponent(JSON.stringify(this.fence()));
    const res = await this.request<{ acks: Array<{ commandId: string; ackCiphertext: string }> }>('GET', `/api/shadow/commands/acks?fence=${fenceParam}`, undefined);
    if (!res.ok) {
      this.handleTransportError(res.status, 'acks');
      return;
    }
    const keyring = await this.keyringFor(this.currentKeyId, this.requireScopeKey());
    for (const row of res.json?.acks ?? []) {
      const ack = await openCommandAck(this.backend, keyring, this.fence(), row.commandId, row.ackCiphertext);
      if (!ack) continue;
      const applyResult = await this.client.applyMessage({ ...ack, family: 'command-ack' });
      // On an accepted ACK, advance the local lifecycle so the completion state
      // event can move the command to `applied`.
      if (applyResult.status === 'applied' && ack.status === 'accepted') {
        await this.client.advanceCommand(ack.commandId, 'execute');
        await this.client.advanceCommand(ack.commandId, 'await-state-event');
      }
    }
  }

  /**
   * Send an allowlisted controller command (encrypted envelope).
   *
   * `opts.idempotencyKey` (Phase 3C3 F1) is the caller's ATTEMPT-STABLE product key: it is
   * sealed INSIDE the encrypted envelope (the host reads it from the decrypted command and
   * keys its exactly-once action receipt on it), so a retry of the same logical attempt
   * converges on ONE product effect. It is NEVER put on the wire in plaintext — the relay's
   * own transport-dedup `idempotencyKey` below is always a fresh per-command random value.
   * When no key is supplied (existing non-action callers), the sealed key is random too, so
   * default behaviour is unchanged.
   */
  async sendCommand(method: string, params: unknown, opts?: { idempotencyKey?: string }): Promise<{ commandId: string }> {
    if (this.state === 'locked') throw new Error('controller locked; cannot send');
    if (this.leaseExpired()) throw new Error('lease expired; read-only until renewed');
    if (this.client.read().connection !== 'online') throw new Error('offline; read-only');
    if (opts?.idempotencyKey !== undefined && !isValidIdempotencyKey(opts.idempotencyKey)) {
      throw new Error('invalid idempotency key'); // fail closed — never silently mint a fresh one
    }
    const commandId = `cmd_${base64urlEncode(this.backend.randomBytes(12))}`;
    // SEALED product key (host exactly-once): the caller's attempt-stable key, else random.
    const sealedIdempotencyKey = opts?.idempotencyKey ?? `idem_${base64urlEncode(this.backend.randomBytes(12))}`;
    // PLAINTEXT relay transport-dedup key: always a distinct per-command random value, so the
    // stable product key never appears on the wire in cleartext.
    const relayIdempotencyKey = `idem_${base64urlEncode(this.backend.randomBytes(12))}`;
    const fence = this.fence();
    // The command-envelope TTL is capped at SHADOW_COMMAND_ENVELOPE_MAX_TTL_MS (2m).
    const expiresAt = this.now() + 90_000;
    await this.client.queueCommand({ commandId, fence, expiresAt, createdAt: this.now() });
    await this.client.markCommandSent(commandId);
    const keyring = await this.keyringFor(this.currentKeyId, this.requireScopeKey());
    const envelope = await sealCommandEnvelope(this.backend, keyring, fence, commandId, { method, params, idempotencyKey: sealedIdempotencyKey });
    const res = await this.request('POST', '/api/shadow/commands', {
      fence, commandId, idempotencyKey: relayIdempotencyKey, envelopeCiphertext: envelope,
      payloadDigest: await sha256Digest(this.backend, new TextEncoder().encode(envelope)),
    });
    if (!res.ok) {
      this.handleTransportError(res.status, 'command');
      throw Object.assign(new Error(res.error ?? 'command send failed'), { statusCode: res.status });
    }
    return { commandId };
  }

  readEntities(): ShadowEntity[] {
    return this.client.read().entities;
  }

  /**
   * Phase 3A2b1 Section B: narrow change-notification for the UI selector layer.
   * Fires (coalesced via microtask) AFTER a durable apply / authority / connection /
   * lock change — never on a raw event. Returns an unsubscribe fn. A listener throw
   * can never affect the service.
   */
  private readonly changeListeners = new Set<() => void>();
  private changeScheduled = false;
  onProjectionChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => { this.changeListeners.delete(fn); };
  }
  private notifyProjectionChange(): void {
    if (this.changeScheduled || this.changeListeners.size === 0) return;
    this.changeScheduled = true;
    queueMicrotask(() => {
      this.changeScheduled = false;
      for (const fn of [...this.changeListeners]) { try { fn(); } catch { /* listener failure is isolated */ } }
    });
  }

  getCommand(commandId: string): CommandLifecycleState | undefined {
    return this.client.read().commands.find((c) => c.commandId === commandId);
  }

  getOfflineTruth(): ReturnType<ShadowMobileClient['getOfflineTruth']> {
    return this.client.getOfflineTruth();
  }

  /** Atomically stop, lock + wipe the scope key + HKDF rings (explicit revocation / 401 / 403). */
  lock(reason: string): void {
    this.lastError = reason;
    this.stopAutoReconcile();
    if (this.scopeKey) this.scopeKey.fill(0);
    this.scopeKey = null;
    for (const [id, key] of this.keyRing) { key.fill(0); this.keyRing.delete(id); }
    for (const kr of this.codecRings.values()) kr.dispose();
    this.codecRings.clear();
    this.state = 'locked';
    void this.client.setOnline(false).catch(() => { /* store may be closing */ });
    this.notifyProjectionChange();
  }

  private handleTransportError(statusCode: number, _where: string): number {
    if (statusCode === 401 || statusCode === 403) {
      this.lock(`denied-${statusCode}`);
    } else {
      void this.client.setOnline(false).catch(() => { /* store may be closing */ });
      if (this.state !== 'locked') this.state = 'offline';
    }
    return 0;
  }

  private async request<T = unknown>(method: string, path: string, body: unknown) {
    const session = await this.opts.session();
    const client = new ShadowRequestClient({
      baseUrl: session.relayOrigin,
      fetch: this.opts.transport.fetch,
      backend: this.backend,
      now: this.now,
      randomNonce: this.opts.transport.randomNonce,
      allowInsecureLoopback: this.opts.transport.allowInsecureLoopback,
      timeoutMs: this.opts.transport.timeoutMs,
      maxResponseBytes: this.opts.transport.maxResponseBytes,
    });
    return client.requestEnrolled<T>(
      { accountId: session.accountId, deviceId: session.controllerDeviceId, sessionToken: session.sessionToken },
      this.opts.controllerSigner,
      { method, path, body },
    );
  }
}
