/* shadow-screen-host — Phase 3D1 host-side screen-stream coordinator (Section C.11).
 *
 * This owns the host end of a view-only, E2EE live screen stream. It:
 *   - verifies EVERY start against the host's LIVE authority at execution time
 *     (never a cached grant) via `decideScreenStart`, requiring the `screen.view`
 *     capability + fence/epoch/lease/source/foreground/permission all valid;
 *   - claims the SOLE viewer (a second controller gets Busy, never steals);
 *   - starts the native capture adapter ONLY after the E2EE session is accepted;
 *   - derives the per-stream key from the ENROLLED host/controller X25519 authority
 *     + fresh nonces, seals each frame, and pushes it through the ephemeral relay;
 *   - stops on every revoke / disconnect / lifecycle / source-loss / permission-loss
 *     / expiry condition, zeroes the key, and emits METADATA-ONLY audit entries
 *     (never a frame byte, window title, or key).
 *
 * Everything IO-shaped (native capture, relay transport, authority, clock, RNG) is
 * injected, so the coordinator is pure control-flow and fully unit/E2E testable. A
 * synthetic capture adapter can therefore drive the REAL production coordinator
 * boundary in CI while the Swift ScreenCaptureKit adapter provides it in the app. */

import type { ShadowCryptoBackend } from '@maestro/realtime/shadowCrypto';
import {
  ScreenFrameSender,
  decideScreenStart,
  decodeScreenControl,
  decodeStreamNonce,
  deriveScreenStreamKey,
  signScreenControl,
  verifyScreenControl,
  isRelayTeardownControl,
  SHADOW_SCREEN_STREAM_MAX_TTL_MS,
  SHADOW_SCREEN_MAX_FPS,
  SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID,
  SHADOW_SCREEN_CONTROL_CLOCK_SKEW_MS,
  type ScreenAuthoritySnapshot,
  type ScreenControlMessage,
  type ScreenControlBinding,
  type ScreenControlSignatureEnvelope,
  type ScreenSourcePolicy,
  type ScreenStartRequest,
  type ScreenStreamBinding,
  type ScreenStreamStatus,
  type ShadowScreenCodec,
} from '@maestro/realtime/shadowScreenStream';

/** The relay's placeholder stream id for a viewer-disconnected teardown (the relay
 * cannot learn the real streamId). Kept in sync with the server's constant. */
const RELAY_TEARDOWN_STREAM_ID = SHADOW_SCREEN_RELAY_TEARDOWN_STREAM_ID;

export interface CaptureStartOptions {
  readonly sourcePolicyId: string;
  readonly codec: ShadowScreenCodec;
  readonly maxDimension: number;
  readonly fps: number;
  readonly onFrame: (frameBytes: Uint8Array, captureTsMs: number) => void;
  readonly onError: (reason: string) => void;
}

export type CaptureStartResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: string };

/** The native capture surface (Swift ScreenCaptureKit in production; synthetic in
 * tests). Never emits audio; never captures anything but the configured source. */
export interface ScreenCaptureAdapter {
  preflightPermission(): Promise<'granted' | 'denied' | 'undetermined'>;
  isSourceAvailable(sourcePolicyId: string): Promise<boolean>;
  start(opts: CaptureStartOptions): Promise<CaptureStartResult>;
  stop(): Promise<void>;
}

/** The relay control/frame transport (the host's /ws/host/screen connection). */
export interface ScreenRelayLink {
  sendControl(msg: ScreenControlMessage): void;
  sendFrame(envelope: Uint8Array): void;
  onControl(cb: (raw: unknown) => void): void;
  onDisconnect(cb: () => void): void;
}

export interface ScreenAuditEntry {
  readonly event: 'stream-started' | 'stream-stopped' | 'stream-denied';
  readonly streamId: string;
  readonly controllerDeviceId: string;
  readonly sourcePolicyClass: 'display';
  readonly at: number;
  readonly durationMs?: number;
  readonly framesSent?: number;
  readonly reason?: string;
}

export interface ScreenStreamHostDeps {
  readonly backend: ShadowCryptoBackend;
  readonly hostAgreementPrivate: Uint8Array;
  /** H1: the host's enrolled Ed25519 signing key — signs every host control. */
  readonly hostSigningPrivate: Uint8Array;
  readonly hostSigningKeyId: string;
  resolveControllerAgreementPublic(controllerDeviceId: string): Uint8Array | null;
  /** H1: the controller's enrolled Ed25519 signing PUBLIC key — verifies the
   * controller's signed start/stop before any capture. Null → unknown → reject. */
  resolveControllerSigningPublic(controllerDeviceId: string): Uint8Array | null;
  /** H1-R2: the authority snapshot MUST be scoped to a specific controller so the
   * `screen.view` capability decision is read from THAT controller's verified grant —
   * never an unscoped/active-viewer snapshot. The provider returns null if the device
   * has no current grant (fail closed) and MUST assert the returned identity matches. */
  authoritySnapshot(controllerDeviceId: string): ScreenAuthoritySnapshot | null;
  sourcePolicy(): ScreenSourcePolicy | null;
  readonly capture: ScreenCaptureAdapter;
  readonly link: ScreenRelayLink;
  now(): number;
  randomNonce(): { bytes: Uint8Array; b64: string };
  audit(entry: ScreenAuditEntry): void;
  /** Phase 3D1: publish host-visible share status (metadata only) for the desktop
   * banner + Controllers pane. `null` = no active viewer. */
  onShareStatus?(status: { active: boolean; deviceLabel: string; sourceLabel: string; startedAtMs: number } | null): void;
}

interface ActiveStream {
  streamId: string;
  controllerDeviceId: string;
  binding: ScreenStreamBinding;
  controlBinding: ScreenControlBinding;
  sender: ScreenFrameSender;
  startedAt: number;
  live: boolean;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** Per-stream control-nonce replay cache for stop/status (H1). */
  seenControlNonces: Set<string>;
}

/** H1-R1: a HOST-WIDE, bounded, sliding-window replay guard for signed `screen-start`
 * controls. Keyed by the full authority tuple + the control nonce so a genuinely-signed
 * start captured off the wire cannot be replayed within the ±skew window to re-trigger
 * capture. Reservation is SYNCHRONOUS (no await between check + insert) so concurrent
 * duplicate starts resolve to exactly one winner; a reserved nonce is RETAINED even if
 * the start later fails (authority/busy/source), closing the retry-replay race. Entries
 * expire at min(skew window, lease/session expiry); cardinality is LRU-bounded. The
 * guard is cleared ONLY on coordinator destruction — never on stream stop. */
class StartReplayGuard {
  private readonly seen = new Map<string, number>(); // key → expiresAtMs
  private readonly maxEntries = 4096;
  constructor(private readonly nowMs: () => number) {}

  private purge(): void {
    const t = this.nowMs();
    for (const [k, exp] of this.seen) if (exp <= t) this.seen.delete(k);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /** Atomically reserve `key`; returns false if it was already reserved (→ replay). */
  reserve(key: string, expiresAtMs: number): boolean {
    this.purge();
    if (this.seen.has(key)) return false;
    this.seen.set(key, expiresAtMs);
    return true;
  }

  size(): number { return this.seen.size; }
  clear(): void { this.seen.clear(); }
}

export class ScreenStreamHostCoordinator {
  private active: ActiveStream | null = null;
  private started = false;
  /** H1-R1: host-wide replay guard for signed START controls (survives stream stop). */
  private readonly startReplay: StartReplayGuard;

  constructor(private readonly deps: ScreenStreamHostDeps) {
    this.startReplay = new StartReplayGuard(deps.now);
  }

  /** Test/introspection: current cardinality of the host-wide start-replay guard. */
  startReplayCacheSize(): number { return this.startReplay.size(); }

  /** Begin listening for controller control messages. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.link.onControl((raw) => { void this.onControl(raw); });
    this.deps.link.onDisconnect(() => { void this.stopActive('link disconnected'); });
  }

  activeViewerDeviceId(): string | null {
    return this.active?.controllerDeviceId ?? null;
  }

  private async onControl(raw: unknown): Promise<void> {
    const decoded = decodeScreenControl(raw, { nowMs: this.deps.now() });
    if (!decoded.ok) return; // ignore malformed — fail closed, no state change
    const msg = decoded.message as ScreenControlMessage & ScreenControlSignatureEnvelope;

    // Transport-local relay teardown (unsigned) may cause a conservative STOP ONLY —
    // never start/live. A disconnected/malicious relay can at worst end a stream.
    if (isRelayTeardownControl(msg)) {
      if (this.active) await this.stopActive('viewer disconnected');
      return;
    }

    if (msg.kind === 'screen-start') { await this.handleStart(msg); return; }
    if (msg.kind === 'screen-stop') {
      // A controller-origin stop must be SIGNED by the enrolled controller + match the
      // active stream's authority binding before it tears anything down.
      const a = this.active;
      if (!a || a.streamId !== msg.streamId) return;
      const pub = this.deps.resolveControllerSigningPublic(a.controllerDeviceId);
      if (!pub) return;
      const v = await verifyScreenControl(this.deps.backend, pub, 'controller', msg, a.controlBinding, { nowMs: this.deps.now(), seenControlNonces: a.seenControlNonces });
      if (v.ok) await this.stopActive('controller stopped');
      return;
    }
    // screen-accept/status from a controller are not host-inbound; ignore.
  }

  private controlBindingFor(req: ScreenStartRequest, authority: ScreenAuthoritySnapshot): ScreenControlBinding {
    return {
      accountId: req.accountId, hostDeviceId: req.hostDeviceId, controllerDeviceId: req.controllerDeviceId,
      grantId: req.grantId, scopeId: req.scopeId, epoch: req.epoch, leaseId: req.leaseId,
      leaseExpiresAt: authority.leaseExpiresAtMs, streamId: req.streamId,
    };
  }

  /** Sign + send a host control (H1). All host controls are Ed25519-signed so the
   * controller can verify them before changing authoritative/live state. */
  private async sendStatus(streamId: string, status: ScreenStreamStatus, reason: string | undefined, binding: ScreenControlBinding): Promise<void> {
    const base: ScreenControlMessage = { kind: 'screen-status', v: 1, streamId, status, reason, at: this.deps.now() };
    const signed = await signScreenControl(this.deps.backend, this.deps.hostSigningPrivate, {
      role: 'host', signerKeyId: this.deps.hostSigningKeyId, controlNonce: this.deps.randomNonce().b64, message: base, binding,
    });
    this.deps.link.sendControl(signed);
  }

  private async handleStart(req: ScreenStartRequest & ScreenControlSignatureEnvelope): Promise<void> {
    const nowMs = this.deps.now();
    // H1-R2: the authority is scoped to THIS controller — the screen.view capability is
    // read from the requesting device's own verified grant, never an active-viewer /
    // unscoped snapshot. No grant for this exact device → fail closed, before capture.
    const authority = this.deps.authoritySnapshot(req.controllerDeviceId);
    if (!authority) {
      this.deps.audit({ event: 'stream-denied', streamId: req.streamId, controllerDeviceId: req.controllerDeviceId, sourcePolicyClass: 'display', at: nowMs, reason: 'no-grant' });
      return;
    }
    const controlBinding = this.controlBindingFor(req, authority);

    // H1: the start MUST be Ed25519-signed by the enrolled controller and bound to the
    // exact account/host/grant/scope/epoch/lease/stream. A relay-forged or unsigned
    // start is rejected HERE, before any authority check or ScreenCaptureKit capture.
    const ctrlSigningPub = this.deps.resolveControllerSigningPublic(req.controllerDeviceId);
    const startNonces = new Set<string>();
    const sigOk = ctrlSigningPub
      ? await verifyScreenControl(this.deps.backend, ctrlSigningPub, 'controller', req, controlBinding, { nowMs, seenControlNonces: startNonces })
      : { ok: false as const, reason: 'unknown-controller' };
    if (!sigOk.ok) {
      await this.sendStatus(req.streamId, 'error', 'unauthorized request', controlBinding);
      this.deps.audit({ event: 'stream-denied', streamId: req.streamId, controllerDeviceId: req.controllerDeviceId, sourcePolicyClass: 'display', at: nowMs, reason: 'unsigned-or-forged' });
      return;
    }

    // H1-R1: atomically reserve this signed start's nonce in the HOST-WIDE replay guard
    // AFTER signature/clock/lease verification but BEFORE any authority/capture work. A
    // replayed genuinely-signed start (same nonce within the skew window) is rejected here
    // — and the reservation is retained even if the start later fails, closing the race.
    const replayKey = `start|${req.controllerDeviceId}|${req.grantId}|${req.accountId}|${req.hostDeviceId}|${req.scopeId}|${req.epoch}|${req.leaseId}|${req.streamId}|${req.controlNonce ?? ''}`;
    const replayExpiry = Math.min(
      nowMs + SHADOW_SCREEN_CONTROL_CLOCK_SKEW_MS,
      authority.leaseExpiresAtMs > 0 ? authority.leaseExpiresAtMs : Number.MAX_SAFE_INTEGER,
      req.expiresAt > 0 ? req.expiresAt : Number.MAX_SAFE_INTEGER,
    );
    if (!this.startReplay.reserve(replayKey, replayExpiry)) {
      this.deps.audit({ event: 'stream-denied', streamId: req.streamId, controllerDeviceId: req.controllerDeviceId, sourcePolicyClass: 'display', at: nowMs, reason: 'replay' });
      return; // reject BEFORE capture; reserved nonce retained to defeat the retry-replay race
    }

    // Already streaming to someone else → Busy (never steal).
    if (this.active && this.active.controllerDeviceId !== req.controllerDeviceId) {
      await this.sendStatus(req.streamId, 'busy', 'another device is viewing', controlBinding);
      this.deps.audit({ event: 'stream-denied', streamId: req.streamId, controllerDeviceId: req.controllerDeviceId, sourcePolicyClass: 'display', at: nowMs, reason: 'busy' });
      return;
    }
    // Same device re-starting: tear the old one down first.
    if (this.active && this.active.controllerDeviceId === req.controllerDeviceId) {
      await this.stopActive('restart');
    }

    // The host ALWAYS captures its own operator-confirmed source — the controller only
    // ever defers to it (M-A). Availability + binding + accept + key all use the CONFIGURED
    // source id, never the request's, so a controller can neither pick nor spoof a display.
    const source = this.deps.sourcePolicy();
    const permission = await this.deps.capture.preflightPermission();
    const sourceAvailable = source ? await this.deps.capture.isSourceAvailable(source.sourcePolicyId) : false;
    const decision = decideScreenStart(req, authority, {
      nowMs,
      activeViewerDeviceId: this.activeViewerDeviceId(),
      permission,
      sourceAvailable,
    });
    if (!decision.ok) {
      await this.sendStatus(req.streamId, decision.status, decision.reason, controlBinding);
      this.deps.audit({ event: 'stream-denied', streamId: req.streamId, controllerDeviceId: req.controllerDeviceId, sourcePolicyClass: 'display', at: nowMs, reason: decision.reason });
      return;
    }

    const controllerPub = this.deps.resolveControllerAgreementPublic(req.controllerDeviceId);
    if (!controllerPub || !source) {
      await this.sendStatus(req.streamId, source ? 'error' : 'source-required', source ? 'unknown controller key' : 'no display configured for viewing', controlBinding);
      return;
    }

    await this.sendStatus(req.streamId, 'starting', undefined, controlBinding);

    // Start capture FIRST to learn the real output dimensions, then bind + key.
    // Honour the controller's requested fps up to the protocol max (10) for smoother
    // motion — the native capture caps its own frame interval, so this can't exceed 10.
    const fps = Math.max(2, Math.min(SHADOW_SCREEN_MAX_FPS, req.requestedFps));
    let started: CaptureStartResult;
    try {
      started = await this.deps.capture.start({
        sourcePolicyId: source.sourcePolicyId,
        codec: req.requestedCodec,
        maxDimension: req.requestedMaxDimension,
        fps,
        onFrame: (bytes, ts) => { void this.onCaptureFrame(req.streamId, bytes, ts); },
        onError: (reason) => { void this.stopActive(reason); },
      });
    } catch (e) {
      await this.sendStatus(req.streamId, 'error', 'capture failed', controlBinding);
      return;
    }
    if (!started.ok) {
      // Preserve the truthful native reason as a distinct status where one exists (the
      // controller shows a matching state; the desktop a configure CTA for source-required).
      const statusForReason: ScreenStreamStatus =
        started.reason === 'permission' ? 'permission-required'
        : started.reason === 'source-required' ? 'source-required'
        : started.reason === 'source-lost' ? 'source-lost'
        : 'error';
      await this.sendStatus(req.streamId, statusForReason, started.reason, controlBinding);
      return;
    }

    const binding: ScreenStreamBinding = {
      streamId: req.streamId,
      accountId: req.accountId,
      hostDeviceId: req.hostDeviceId,
      controllerDeviceId: req.controllerDeviceId,
      grantId: req.grantId,
      scopeId: req.scopeId,
      epoch: req.epoch,
      leaseId: req.leaseId,
      leaseExpiresAt: authority.leaseExpiresAtMs,
      sourcePolicyId: source.sourcePolicyId, // the CONFIGURED display — both sides bind this
      codec: req.requestedCodec,
      width: started.width,
      height: started.height,
    };
    const keyEpoch = 1;
    const hostNonce = this.deps.randomNonce();
    try {
      const controllerNonce = decodeStreamNonce(req.controllerNonce);
      const key = await deriveScreenStreamKey({
        backend: this.deps.backend,
        selfAgreementPrivate: this.deps.hostAgreementPrivate,
        peerAgreementPublic: controllerPub,
        hostNonce: hostNonce.bytes,
        controllerNonce,
        binding,
        keyEpoch,
      });
      const sender = new ScreenFrameSender(this.deps.backend, key, binding, keyEpoch);
      const expiresAt = Math.min(req.expiresAt, nowMs + SHADOW_SCREEN_STREAM_MAX_TTL_MS, authority.leaseExpiresAtMs);
      const expiryTimer = setTimeout(() => { void this.stopActive('session expired'); }, Math.max(0, expiresAt - nowMs));
      if (typeof (expiryTimer as { unref?: () => void }).unref === 'function') (expiryTimer as { unref: () => void }).unref();

      this.active = { streamId: req.streamId, controllerDeviceId: req.controllerDeviceId, binding, controlBinding, sender, startedAt: nowMs, live: false, expiresAt, expiryTimer, seenControlNonces: startNonces };

      // Host-sign the accept so the controller verifies it before deriving the key /
      // trusting the source label.
      const acceptBase: ScreenControlMessage = {
        kind: 'screen-accept', v: 1, streamId: req.streamId, hostNonce: hostNonce.b64,
        codec: binding.codec, width: binding.width, height: binding.height, fps, keyEpoch,
        sourcePolicyId: source.sourcePolicyId, sourceLabel: source.label, acceptedAt: nowMs, expiresAt,
      };
      const signedAccept = await signScreenControl(this.deps.backend, this.deps.hostSigningPrivate, {
        role: 'host', signerKeyId: this.deps.hostSigningKeyId, controlNonce: this.deps.randomNonce().b64, message: acceptBase, binding: controlBinding,
      });
      this.deps.link.sendControl(signedAccept);
      this.deps.audit({ event: 'stream-started', streamId: req.streamId, controllerDeviceId: req.controllerDeviceId, sourcePolicyClass: 'display', at: nowMs });
      this.deps.onShareStatus?.({ active: true, deviceLabel: `Device ${req.controllerDeviceId.slice(-4)}`, sourceLabel: source.label, startedAtMs: nowMs });
    } catch {
      // Key derivation / accept signing failed after capture started — stop the native
      // capture and surface a truthful error rather than leaving a half-open stream.
      try { await this.deps.capture.stop(); } catch { /* */ }
      await this.sendStatus(req.streamId, 'error', 'stream setup failed', controlBinding);
    }
  }

  private async onCaptureFrame(streamId: string, frameBytes: Uint8Array, captureTsMs: number): Promise<void> {
    const a = this.active;
    if (!a || a.streamId !== streamId) return;
    // Re-verify authority every frame window is overkill; expiry timer + explicit
    // revoke/stop cover it. Guard against post-expiry frames here too.
    if (this.deps.now() >= a.expiresAt) { await this.stopActive('session expired'); return; }
    let envelope: Uint8Array;
    try {
      envelope = await a.sender.seal(frameBytes, captureTsMs);
    } catch {
      await this.stopActive('encode failed');
      return;
    }
    this.deps.link.sendFrame(envelope);
    if (!a.live) {
      a.live = true;
      await this.sendStatus(streamId, 'live', undefined, a.controlBinding);
    }
  }

  /** Called by the host when live authority changes (revoke / fence / capability). */
  async onAuthorityChanged(): Promise<void> {
    const a = this.active;
    if (!a) return;
    // Scope the re-check to the ACTIVE viewer (H1-R2): a null snapshot = the viewer's
    // grant is gone → stop immediately.
    const auth = this.deps.authoritySnapshot(a.controllerDeviceId);
    if (!auth) { await this.stopActive('authority changed'); return; }
    const f = auth.fence;
    const b = a.binding;
    const stillValid =
      auth.hostOnline &&
      !auth.revokedControllerDeviceIds.includes(a.controllerDeviceId) &&
      auth.leaseExpiresAtMs > this.deps.now() &&
      auth.grantedCapabilities.includes('screen.view') &&
      // M-A: the operator un-confirming (or changing) the display stops the live stream.
      auth.configuredSourcePolicyId === b.sourcePolicyId &&
      f.accountId === b.accountId && f.hostDeviceId === b.hostDeviceId && f.scopeId === b.scopeId && f.epoch === b.epoch;
    if (!stillValid) await this.stopActive('authority changed');
  }

  /** Explicit host-side stop (operator clicked "Stop sharing"). */
  async stopByHost(): Promise<void> {
    await this.stopActive('host stopped sharing');
  }

  /** Full teardown of the coordinator (sign-out / shutdown). Stops any active stream AND
   * clears the host-wide start-replay guard — the ONLY place the guard is cleared, so a
   * stream stop never re-opens the replay window (H1-R1). */
  async destroy(): Promise<void> {
    await this.stopActive('coordinator destroyed');
    this.startReplay.clear();
  }

  private async stopActive(reason: string): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.deps.onShareStatus?.(null);
    if (a.expiryTimer) clearTimeout(a.expiryTimer);
    try { await this.deps.capture.stop(); } catch { /* */ }
    const framesSent = a.sender.currentSeq();
    a.sender.dispose(); // zero key
    await this.sendStatus(a.streamId, 'stopped', reason, a.controlBinding);
    this.deps.audit({
      event: 'stream-stopped', streamId: a.streamId, controllerDeviceId: a.controllerDeviceId,
      sourcePolicyClass: 'display', at: this.deps.now(), durationMs: this.deps.now() - a.startedAt, framesSent, reason,
    });
  }
}
