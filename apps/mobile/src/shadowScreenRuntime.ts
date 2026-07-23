/* shadowScreenRuntime — Phase 3D1 (correction B1) PRODUCTION mobile screen-stream
 * owner. This is the missing runtime seam the reviewer flagged: it actually
 * CONSTRUCTS a `ScreenStreamClient`, retrieves the enrolled controller/host key
 * material through the enrollment runtime (never into React state / logs /
 * AsyncStorage), dials `/ws/remote/screen` over the RN global WebSocket, and
 * ATTACHES the client to the `ScreenViewerStore` — so a granted "View screen" sends
 * a real signed start and the store receives status + the first decoded frame.
 *
 * It detaches + zeroes on logout / revoke / purge / account-host-grant-fence-epoch
 * change (via the session + active-host subscriptions), and requires a FRESH stream +
 * key on every reconnect (the WS link opens per stream). Everything IO-shaped is
 * injected so the owner is unit-testable in an isolated RN-free harness. */

import { ScreenStreamClient, type ScreenClientLink, type ScreenClientState, type ScreenClientIdentity } from './shadowScreenClient';
import type { ScreenViewerStore } from './shadowScreenViewerStore';
import type { ShadowCryptoBackend } from '@maestro/realtime/shadowCrypto';
import { SHADOW_SCREEN_HOST_CONFIGURED_SOURCE, SHADOW_SCREEN_MAX_FPS } from '@maestro/realtime/shadowScreenStream';

/** The enrolled material a screen client needs (from `ShadowMobileEnrollmentRuntime
 * .screenClientMaterial()`). Raw private bytes only ever flow runtime → client. */
export interface ScreenClientMaterial {
  readonly controllerAgreementPrivate: Uint8Array;
  readonly hostAgreementPublic: Uint8Array;
  readonly controllerSigningPrivate: Uint8Array;
  readonly controllerSigningKeyId: string;
  readonly hostSigningPublic: Uint8Array;
  readonly identity: { accountId: string; hostDeviceId: string; controllerDeviceId: string; grantId: string; scopeId: string; epoch: number; leaseId: string; leaseExpiresAt: number };
}

/** The minimal WebSocket surface (RN global `WebSocket`), injectable for tests. */
export interface ScreenWsLike {
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(): void;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

export interface ScreenSessionInfo {
  readonly relayOrigin: string;
  readonly sessionToken: string;
  readonly deviceId: string;
  readonly hostId: string;
}

export interface ScreenRuntimeDeps {
  readonly backend: ShadowCryptoBackend;
  readonly store: Pick<ScreenViewerStore, 'attach' | 'onClientState' | 'setAuthority'>;
  /** Enrolled key material, or null when unenrolled/revoked/locked. */
  getMaterial(): Promise<ScreenClientMaterial | null>;
  /** True iff the VERIFIED current grant includes `screen.view`. */
  isScreenViewGranted(): Promise<boolean>;
  /** Current session (server + token + device + active host), or null when signed out. */
  session(): ScreenSessionInfo | null;
  isOnline(): boolean;
  hostName(): string;
  createWs(url: string): ScreenWsLike;
  subscribeSession(cb: () => void): () => void;
  subscribeActiveHost(cb: () => void): () => void;
  /** B1-R1: fire on ANY grant/authority change — restore success, fresh enrollment
   * accept, revoke, lease/fence/epoch/capability change, purge/logout. This is the
   * signal that makes "View screen" work on the two primary installed flows (cold-start
   * with a restored grant, and just-enrolled) where session/host do NOT change. */
  subscribeGrant(cb: () => void): () => void;
  now(): number;
  newStreamId(): string;
}

/** A lazy-connect WS `ScreenClientLink`: opens `/ws/remote/screen` on the first
 * control send (the signed start), routes text→control / binary→frame, and closes on
 * stop / disconnect so each stream gets a fresh socket + key. */
class ScreenRelayWsLink implements ScreenClientLink {
  private ws: ScreenWsLike | null = null;
  private controlCb: ((raw: unknown) => void) | null = null;
  private frameCb: ((env: Uint8Array) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private queue: string[] = [];
  private closed = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAttempts = 0;

  constructor(private readonly url: string, private readonly createWs: (u: string) => ScreenWsLike) {}

  onControl(cb: (raw: unknown) => void): void { this.controlCb = cb; }
  onFrame(cb: (env: Uint8Array) => void): void { this.frameCb = cb; }
  onDisconnect(cb: () => void): void { this.disconnectCb = cb; }

  sendControl(msg: unknown): void {
    const text = JSON.stringify(msg);
    this.ensureOpen();
    if (this.ws && this.ws.readyState === 1 /* OPEN */) { try { this.ws.send(text); } catch { /* */ } }
    else this.queue.push(text);
    // Close the socket shortly after a controller stop (fresh stream on next view).
    if (typeof msg === 'object' && msg && (msg as { kind?: string }).kind === 'screen-stop') this.scheduleClose();
  }

  private ensureOpen(): void {
    if (this.ws || this.closed) return;
    try { console.log(`[DIAG4] link OPENING (attempt ${this.connectAttempts}) ${this.url.replace(/token=[^&]+/, 'token=***')}`); } catch { /* */ }
    const ws = this.createWs(this.url);
    this.ws = ws;
    // Connect watchdog: the RN/okhttp WebSocket can hang mid-handshake with no open/
    // error/close event (a wedged/pooled connection), leaving the viewer stuck on
    // "Waiting" forever. If we don't reach onopen within the timeout, force-close and
    // retry a fresh socket (bounded), then give up + report disconnect so the UI recovers.
    if (this.connectTimer) { clearTimeout(this.connectTimer); }
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      try { console.log(`[DIAG4] link TIMEOUT (attempt ${this.connectAttempts}) — retrying`); } catch { /* */ }
      try { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; } catch { /* */ }
      try { ws.close(); } catch { /* */ }
      if (this.ws === ws) this.ws = null;
      if (this.closed) return;
      if (this.connectAttempts < 6) { this.connectAttempts += 1; this.ensureOpen(); }
      else { this.connectAttempts = 0; this.disconnectCb?.(); }
    }, 7000);
    ws.onopen = () => { if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; } this.connectAttempts = 0; try { console.log(`[DIAG4] link OPEN (queued=${this.queue.length})`); } catch { /* */ } const q = this.queue; this.queue = []; for (const t of q) { try { ws.send(t); } catch { /* */ } } };
    ws.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string') { try { this.controlCb?.(JSON.parse(d)); } catch { /* */ } return; }
      // binary frame → Uint8Array
      if (d instanceof ArrayBuffer) { this.frameCb?.(new Uint8Array(d)); return; }
      if (d && typeof (d as { byteLength?: number }).byteLength === 'number') { this.frameCb?.(new Uint8Array((d as ArrayBufferView).buffer)); return; }
    };
    ws.onclose = () => { if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; } try { console.log(`[DIAG4] link CLOSE`); } catch { /* */ } if (this.ws === ws) this.ws = null; this.disconnectCb?.(); };
    ws.onerror = () => { try { console.log(`[DIAG4] link ERROR`); } catch { /* */ } try { ws.close(); } catch { /* */ } };
  }

  private scheduleClose(): void {
    const ws = this.ws;
    if (!ws) return;
    setTimeout(() => { try { ws.close(); } catch { /* */ } }, 50);
  }

  /** Runtime-initiated teardown (detach / logout / revoke). */
  destroy(): void {
    this.closed = true;
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onclose = null; try { ws.close(); } catch { /* */ } }
  }
}

export class ScreenRuntime {
  private client: ScreenStreamClient | null = null;
  private link: ScreenRelayWsLink | null = null;
  private started = false;
  private material: ScreenClientMaterial | null = null;
  private refreshing = false;
  private pendingRefresh = false;
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly deps: ScreenRuntimeDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    // B1-R1: refresh on session, active-host AND grant/authority change. The grant
    // subscription is the one that fires on cold-start restore + fresh-enroll accept,
    // which are exactly the flows where session/host DON'T change — so the client now
    // attaches and "View screen" is no longer a silent no-op.
    this.unsubs.push(this.deps.subscribeSession(() => { void this.refresh(); }));
    this.unsubs.push(this.deps.subscribeActiveHost(() => { void this.refresh(); }));
    this.unsubs.push(this.deps.subscribeGrant(() => { void this.refresh(); }));
    void this.refresh();
  }

  /** Cancellable teardown: unsubscribe + detach + zero (App boot cleanup). */
  dispose(): void {
    for (const u of this.unsubs.splice(0)) { try { u(); } catch { /* */ } }
    this.detach();
    this.started = false;
  }

  /** True when a live production client is attached (used by contract tests). */
  isAttached(): boolean { return this.client !== null; }

  /**
   * Rebuild the attached client to match the current authority: attach a real client
   * when enrolled + `screen.view`-granted + online; detach + zero otherwise. Idempotent.
   */
  async refresh(): Promise<void> {
    // Re-entrancy: coalesce, but NEVER drop — a grant change that lands mid-refresh must
    // be reflected, so remember it and re-run once the in-flight pass finishes. This is
    // what closes the "grant restored during the boot refresh" race (B1-R1).
    if (this.refreshing) { this.pendingRefresh = true; return; }
    this.refreshing = true;
    try {
      const granted = await this.deps.isScreenViewGranted().catch(() => false);
      const online = this.deps.isOnline();
      const session = this.deps.session();
      const material = granted && session ? await this.deps.getMaterial().catch(() => null) : null;
      this.deps.store.setAuthority({ screenViewGranted: granted, online, hostName: this.deps.hostName() });

      if (!granted || !material || !session) { this.detach(); return; }
      // (Re)attach only when the identity changed (account/host/grant/lease/epoch).
      const same = this.material && sameIdentity(this.material.identity, material.identity);
      if (this.client && same) return;
      this.detach();
      this.material = material;
      const id: ScreenClientIdentity = {
        accountId: material.identity.accountId, hostDeviceId: material.identity.hostDeviceId, controllerDeviceId: material.identity.controllerDeviceId,
        grantId: material.identity.grantId, scopeId: material.identity.scopeId, epoch: material.identity.epoch,
        // M-A: the controller ALWAYS defers to the host's confirmed display — it never
        // names a concrete source (it can't enumerate them). The host substitutes its
        // operator-chosen display and echoes the real id in the signed accept.
        leaseId: material.identity.leaseId, leaseExpiresAt: material.identity.leaseExpiresAt, sourcePolicyId: SHADOW_SCREEN_HOST_CONFIGURED_SOURCE,
        // Request the protocol's max fps (10) for the smoothest motion the host allows;
        // the host clamps to [2,10] and its own capture cost. 1280 keeps frames legible.
        requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: SHADOW_SCREEN_MAX_FPS,
      };
      const url = `${session.relayOrigin.replace(/^http/, 'ws').replace(/\/$/, '')}/ws/remote/screen?token=${encodeURIComponent(session.sessionToken)}&did=${encodeURIComponent(session.deviceId)}&host=${encodeURIComponent(session.hostId)}`;
      const link = new ScreenRelayWsLink(url, (u) => this.deps.createWs(u));
      const client = new ScreenStreamClient({
        backend: this.deps.backend,
        controllerAgreementPrivate: material.controllerAgreementPrivate,
        hostAgreementPublic: material.hostAgreementPublic,
        controllerSigningPrivate: material.controllerSigningPrivate,
        controllerSigningKeyId: material.controllerSigningKeyId,
        hostSigningPublic: material.hostSigningPublic,
        identity: id, link,
        now: this.deps.now, newStreamId: this.deps.newStreamId,
        onState: (s: ScreenClientState) => this.deps.store.onClientState(s),
      });
      this.link = link;
      this.client = client;
      this.deps.store.attach(client); // ← the real client is attached in NON-TEST code
    } finally {
      this.refreshing = false;
      if (this.pendingRefresh) { this.pendingRefresh = false; void this.refresh(); }
    }
  }

  /** Detach + zero: stop the client (sends stop, disposes key/frame) + close the WS. */
  detach(): void {
    if (this.client) { try { this.client.stop('runtime detach'); } catch { /* */ } this.client = null; }
    if (this.link) { this.link.destroy(); this.link = null; }
    this.material = null;
  }
}

function sameIdentity(a: ScreenClientMaterial['identity'], b: ScreenClientMaterial['identity']): boolean {
  return a.accountId === b.accountId && a.hostDeviceId === b.hostDeviceId && a.controllerDeviceId === b.controllerDeviceId
    && a.grantId === b.grantId && a.scopeId === b.scopeId && a.epoch === b.epoch && a.leaseId === b.leaseId;
}
