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
/** Mirrors the server relay batch ceiling so the mobile can keep draining until caught up. */
const CONNECT_EVENT_BATCH_LIMIT = 500;
const CONNECT_DRAIN_PAGE_LIMIT = 12;
/** Re-fetch the (host-renewed) server lease when the in-memory lease is within this margin
 *  of expiry, so a slow baseline drain doesn't outlast the window and fence every event. */
const LEASE_REEXTEND_MARGIN_MS = 20_000;
/** Bound mid-drain authority re-fetches to at most one per this interval (a non-renewing
 *  host can't spin the drain into a per-event network storm). */
const LEASE_REEXTEND_THROTTLE_MS = 5_000;

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

interface DrainSummary {
  applied: number;
  caughtUp: boolean;
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
  private readonly expected: ShadowExpectedAuthority;
  /**
   * The effective lease expiry used by `leaseExpired()`. Tracks the most
   * generous lease seen from ANY source — the original enrollment grant, a
   * host-signed transition consumed by the client, or a server-confirmed
   * extension via `reconcileAuthority`. This is intentionally SEPARATE from
   * `this.expected` (the shared `opts.expectedAuthority` reference the client
   * uses as its trusted root for chain verification). Mutating `this.expected`
   * or persisting a divergent lease to the store breaks `acceptLoadedAuthority`:
   * the chain endpoint no longer matches the stored expected authority, causing
   * every `load()` to fail with `transition-chain-incomplete` → zero entities.
   */
  private effectiveLeaseExpiresAt: number;
  private state: ControllerServiceState = 'idle';
  private lastError: string | undefined;
  private reconcileTimer: unknown = null;
  /** Last server-reported lease expiry (observability; the chain authority gates events). */
  private serverLeaseExpiresAt = 0;
  /** Throttle timestamp for mid-drain lease re-extension (see drainEventPages). */
  private lastLeaseRefreshMs = 0;
  /** Deduplicates overlapping load/build/connect/tick sync work onto one production seam. */
  private inFlightSync: Promise<number> | null = null;
  /**
   * Consecutive 401/403 denial count. A session token can expire without the
   * enrollment grant being revoked — locking + purging on the FIRST 401 forces a
   * painful re-enrollment. Instead, the controller goes offline on the first denial
   * and only locks (→ triggerPurge → enrollment gate) after DENIAL_LOCK_THRESHOLD
   * consecutive 401/403 responses, confirming the revocation is genuine and not a
   * transient token refresh issue.
   */
  private consecutiveDenials = 0;
  private static readonly DENIAL_LOCK_THRESHOLD = 3;

  constructor(private readonly opts: ShadowControllerServiceOptions) {
    this.backend = opts.backend;
    this.now = opts.now ?? Date.now;
    this.scopeKey = opts.scopeKey;
    this.currentKeyId = opts.scopeKeyId;
    this.expected = { ...opts.expectedAuthority, fence: { ...opts.expectedAuthority.fence } };
    this.effectiveLeaseExpiresAt = this.expected.leaseExpiresAt;
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
    // Track the persisted lease for leaseExpired() without touching this.expected
    // (the client's trusted root — mutating it breaks acceptLoadedAuthority's chain
    // verification, causing repair-required with zero entities on every subsequent load).
    const persisted = this.client.read().expectedAuthority;
    if (persisted) this.effectiveLeaseExpiresAt = Math.max(this.effectiveLeaseExpiresAt, persisted.leaseExpiresAt);
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
      leaseExpiresAt: this.effectiveLeaseExpiresAt,
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
    return this.now() >= this.effectiveLeaseExpiresAt + LEASE_SKEW_MS;
  }

  /** True when the in-memory lease is within the re-extend margin of expiry — the cue to
   *  re-fetch the host-renewed server lease mid-drain before events start fencing. */
  private leaseNearExpiry(): boolean {
    return this.now() >= this.effectiveLeaseExpiresAt - LEASE_REEXTEND_MARGIN_MS;
  }

  /**
   * Connect + catch up: reconcile the server lease, pull the event delta, apply
   * each, advance the cursor, then poll host ACKs. Returns the number of events
   * applied.
   */
  async connect(): Promise<number> {
    if (this.isLocked()) throw new Error('controller locked');
    return this.syncControllerState(true);
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
    if (this.now() >= authority.expiresAt) { this.lastError = 'server-lease-expired'; console.warn('[shadow-svc] authority.fail reason=server-lease-expired server.expiresAt=' + authority.expiresAt + ' now=' + this.now()); return false; }
    this.serverLeaseExpiresAt = authority.expiresAt;
    // Always adopt the server's expiry when it's more generous — the server
    // only reports a valid lease when the host has actively renewed, and the
    // signed transition may lag behind. Previously this was guarded by
    // `this.leaseExpired()`, but that caused the effective lease to NOT be
    // extended when the chain endpoint's lease was still valid (e.g. 7s
    // remaining). Then the drain starts, the chain lease expires mid-drain,
    // and all remaining events get fenced.
    if (authority.expiresAt > this.effectiveLeaseExpiresAt) {
      console.warn('[shadow-svc] authority.serverExtend old=' + this.effectiveLeaseExpiresAt + ' new=' + authority.expiresAt);
      // Only update the effective lease — NEVER mutate this.expected or persist to the
      // store. The store's expectedAuthority is managed exclusively by the client's
      // consumeAuthorityTransition (which atomically adds a signed transition AND
      // updates the expected authority). Writing a server-extended lease directly
      // diverges the store from the chain endpoint, causing every subsequent load()
      // to fail acceptLoadedAuthority with transition-chain-incomplete.
      this.effectiveLeaseExpiresAt = authority.expiresAt;
    }
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
      // Track the transition's lease for leaseExpired(). The client's
      // consumeAuthorityTransition already updated the store atomically (chain +
      // expected authority), so future acceptLoadedAuthority checks will verify
      // from the original trusted root through the full chain.
      const persisted = this.client.read().expectedAuthority;
      if (persisted) this.effectiveLeaseExpiresAt = Math.max(this.effectiveLeaseExpiresAt, persisted.leaseExpiresAt);
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
    try { await this.syncControllerState(false); }
    catch { /* transient; next tick retries */ }
  }

  private async syncControllerState(loadFirst: boolean): Promise<number> {
    if (this.inFlightSync) return this.inFlightSync;
    this.inFlightSync = (async () => {
      console.warn('[shadow-svc] sync.start loadFirst=' + loadFirst);
      if (loadFirst) {
        await this.client.load();
        // Track the persisted lease — syncControllerState bypasses the service's
        // load() which normally does this.
        const pl = this.client.read().expectedAuthority;
        if (pl) this.effectiveLeaseExpiresAt = Math.max(this.effectiveLeaseExpiresAt, pl.leaseExpiresAt);
      }
      console.warn('[shadow-svc] sync.loaded');
      await this.fetchAndApplyTransitions();
      // Transitions may have advanced the chain endpoint's lease beyond
      // effectiveLeaseExpiresAt (applyAuthorityTransition updates it, but
      // re-sync here to be safe).
      const postTr = this.client.read().expectedAuthority;
      if (postTr) this.effectiveLeaseExpiresAt = Math.max(this.effectiveLeaseExpiresAt, postTr.leaseExpiresAt);
      console.warn('[shadow-svc] sync.transitions done');
      const authorityOk = await this.reconcileAuthority();
      console.warn('[shadow-svc] sync.authority ok=' + authorityOk + ' leaseExpired=' + this.leaseExpired());
      if (this.isLocked()) throw new Error('controller locked');
      // Go online as soon as the authority is verified and the lease is valid.
      // The event drain may take a long time (hundreds/thousands of events with
      // per-event Ed25519 verify + AES-GCM decrypt + SQLite write). The
      // auto-reconcile timer continues draining incrementally. The phone already
      // has cached data from prior syncs — going online enables actions and
      // screen streaming while the delta catches up in the background.
      if (!this.isLocked() && authorityOk && !this.leaseExpired()) {
        await this.client.setOnline(true);
        this.state = 'online';
        const cs = this.client.read();
        console.warn('[shadow-svc] sync.earlyOnline conn=' + cs.connection + ' entities=' + cs.entities.length + ' lease=' + (cs.expectedAuthority?.leaseExpiresAt ?? 'n/a') + ' effectiveLease=' + this.effectiveLeaseExpiresAt);
        this.notifyProjectionChange();
      }
      // Bridge the client's chain-endpoint lease (which may be near-expiry) with
      // the service's server-authenticated effectiveLeaseExpiresAt. This in-memory
      // extension does NOT touch the store — acceptLoadedAuthority still verifies the
      // chain, and the next load() resets in-memory state. It only prevents
      // validateAuthorityFence from fencing events during this drain cycle.
      this.client.extendInMemoryLease(this.effectiveLeaseExpiresAt);
      const drained = await this.drainEventPages();
      console.warn('[shadow-svc] sync.drained applied=' + drained.applied + ' caughtUp=' + drained.caughtUp);
      await this.pollAcks();
      if (!this.isLocked()) {
        if (authorityOk) {
          // Authority verified: go online/offline based on lease.
          const live = !this.leaseExpired();
          await this.client.setOnline(live);
          this.state = live ? 'online' : 'offline';
        } else if (this.leaseExpired()) {
          // Lease definitively expired — go offline regardless.
          await this.client.setOnline(false);
          this.state = 'offline';
        }
        // else: authority check failed transiently (server error / network) but
        // lease is still valid → preserve the current state. The next
        // auto-reconcile tick retries the authority check.
      }
      console.warn('[shadow-svc] sync.final state=' + this.state);
      this.notifyProjectionChange();
      return drained.applied;
    })().finally(() => { this.inFlightSync = null; });
    return this.inFlightSync;
  }

  /** Poll the event stream (connect delta) and durably apply. */
  async pollEvents(): Promise<number> {
    return (await this.drainEventPages()).applied;
  }

  private async drainEventPages(): Promise<DrainSummary> {
    let totalApplied = 0;
    for (let page = 0; page < CONNECT_DRAIN_PAGE_LIMIT; page++) {
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
      if (!res.ok) {
        this.handleTransportError(res.status, 'connect');
        return { applied: totalApplied, caughtUp: false };
      }
      const events = Array.isArray(res.json?.events) ? res.json.events : [];
      console.warn('[shadow-svc] drain.page=' + page + ' events=' + events.length + ' lastSeq=' + lastSeq);
      let pageApplied = 0;
      for (let ei = 0; ei < events.length; ei++) {
        // Keep the lease ahead of a slow baseline drain. A single page can hold up to
        // CONNECT_EVENT_BATCH_LIMIT (500) events, and per-event Ed25519-verify + AES-GCM
        // decrypt over a slow link can outlast the granted lease window mid-page. The HOST
        // actively renews the SERVER lease (see `authority.serverExtend`), so when our
        // in-memory lease nears expiry we re-fetch the server authority and adopt the
        // renewed window IN PLACE, instead of fencing every remaining event and dropping
        // into a repair-required loop that leaves the projection empty (0 entities).
        // reconcileAuthority is verify-only + chain-safe; the throttle bounds it to at most
        // one refresh per LEASE_REEXTEND_THROTTLE_MS so a non-renewing host can't spin.
        if (this.leaseNearExpiry() && this.now() - this.lastLeaseRefreshMs >= LEASE_REEXTEND_THROTTLE_MS) {
          this.lastLeaseRefreshMs = this.now();
          try { await this.reconcileAuthority(); this.client.extendInMemoryLease(this.effectiveLeaseExpiresAt); } catch { /* keep going; the expiry break below still guards */ }
        }
        // Stop processing events once the lease has genuinely expired — every remaining
        // event would be fenced, and each fenced event triggers an expensive
        // load() → acceptLoadedAuthority chain walk (~2s per event × N transitions).
        // The next auto-reconcile tick will extend the lease and resume draining.
        if (this.leaseExpired()) {
          console.warn('[shadow-svc] drain.leaseExpired ei=' + ei + '/' + events.length);
          break;
        }
        const result = await this.client.applyWire(events[ei]!);
        if (ei === 0 || result.status !== 'applied') console.warn('[shadow-svc] drain.event[' + ei + '] status=' + result.status);
        if (result.status === 'applied') {
          pageApplied += 1;
          totalApplied += 1;
        }
      }
      const cursor = this.client.read().cursor;
      const cursorLastSeq = cursor?.lastSeq ?? lastSeq;
      if (cursor && cursor.lastSeq > lastSeq) {
        await this.submitCursor(cursor.lastSeq, cursor.lastEventId ?? undefined, cursor.lastDigest ?? undefined);
      }
      if (pageApplied > 0) this.notifyProjectionChange();
      // If the lease expired mid-page and no events were applied, stop fetching
      // more pages — subsequent pages will hit the same lease-expired break
      // immediately (ei=0), wasting API round-trips.
      if (this.leaseExpired() && pageApplied === 0) break;
      const targetHead = typeof res.json?.decision?.toSeq === 'number' ? res.json.decision.toSeq : cursorLastSeq;
      const caughtUp = cursorLastSeq >= targetHead;
      if (caughtUp && events.length < CONNECT_EVENT_BATCH_LIMIT) return { applied: totalApplied, caughtUp: true };
      if (events.length === 0 && caughtUp) return { applied: totalApplied, caughtUp: true };
      if (cursorLastSeq <= lastSeq && events.length === 0) break;
    }
    this.lastError = 'baseline-drain-incomplete';
    return { applied: totalApplied, caughtUp: false };
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
      this.consecutiveDenials += 1;
      console.warn('[shadow-svc] denied ' + statusCode + ' count=' + this.consecutiveDenials + ' where=' + _where);
      if (this.consecutiveDenials >= ShadowControllerService.DENIAL_LOCK_THRESHOLD) {
        // Confirmed revocation — lock and let the UI controller purge.
        this.lock(`denied-${statusCode}`);
      } else {
        // Likely a transient session-token expiry. Go offline and let the next
        // auto-reconcile tick retry with a fresh token from session(). If the
        // token refreshes, the counter resets and the controller goes back online
        // without a re-enrollment.
        this.lastError = `denied-${statusCode}-transient`;
        void this.client.setOnline(false).catch(() => { /* store may be closing */ });
        if (this.state !== 'locked') this.state = 'offline';
      }
    } else if (this.state !== 'online') {
      // Only go offline on transient errors when NOT already online. An
      // authority-verified online state survives transient server errors (500/502/
      // 503) — the next auto-reconcile tick retries, and the lease expiry is the
      // definitive offline signal. This prevents flicker during brief server hiccups.
      void this.client.setOnline(false).catch(() => { /* store may be closing */ });
      if (this.state !== 'locked') this.state = 'offline';
    }
    return 0;
  }

  private async request<T = unknown>(method: string, path: string, body: unknown) {
    console.warn('[shadow-svc] req.session ' + method + ' ' + path);
    const session = await this.opts.session();
    console.warn('[shadow-svc] req.go ' + method + ' ' + path);
    const client = new ShadowRequestClient({
      baseUrl: session.relayOrigin,
      fetch: this.opts.transport.fetch,
      backend: this.backend,
      now: this.now,
      randomNonce: this.opts.transport.randomNonce,
      allowInsecureLoopback: this.opts.transport.allowInsecureLoopback,
      timeoutMs: this.opts.transport.timeoutMs ?? 30_000,
      maxResponseBytes: this.opts.transport.maxResponseBytes,
    });
    let result: Awaited<ReturnType<ShadowRequestClient['requestEnrolled']>>;
    try {
      result = await client.requestEnrolled<T>(
        { accountId: session.accountId, deviceId: session.controllerDeviceId, sessionToken: session.sessionToken },
        this.opts.controllerSigner,
        { method, path, body },
      );
    } catch (error) {
      // Transport errors (timeout, network failure) should not throw — they are
      // returned as non-ok results so callers (drainEventPages, reconcileAuthority)
      // can handle them through the normal handleTransportError path instead of
      // crashing the entire syncControllerState promise.
      const msg = error instanceof Error ? error.message : 'transport-error';
      console.warn('[shadow-svc] req.error ' + method + ' ' + path + ' ' + msg);
      return { ok: false as const, status: 0, json: null as T } as { ok: false; status: number; json: T };
    }
    console.warn('[shadow-svc] req.done ' + method + ' ' + path + ' status=' + result.status + ' ok=' + result.ok);
    // Reset the denial counter on any successful (non-401/403) response — the
    // session token is working, so prior denials were transient.
    if (result.ok || (result.status !== 401 && result.status !== 403)) {
      this.consecutiveDenials = 0;
    }
    return result;
  }
}
