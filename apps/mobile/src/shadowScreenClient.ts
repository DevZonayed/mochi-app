/* shadowScreenClient — Phase 3D1 controller-side screen-stream client (Section D).
 *
 * The mobile controller's half of a view-only, E2EE live screen stream. It is
 * platform-free: the crypto backend, the relay transport, the clock and RNG are all
 * injected, so it runs identically in the E2E (Node) and in the RN app. It:
 *   - sends a `screen-start` with a fresh controller nonce;
 *   - on `screen-accept`, derives the SAME per-stream key the host derived (enrolled
 *     X25519 authority + both nonces) and builds a replay-safe frame receiver;
 *   - decrypts each frame, keeping ONLY the latest decoded frame (the previous is
 *     dropped/zeroed immediately — no history, no persistence);
 *   - never reports "live" before the first authenticated decoded frame;
 *   - can be stopped locally at any time (foreground exit / route change / user),
 *     which sends `screen-stop`, zeroes the key and the latest frame.
 *
 * There is NO input path: the client only ever RECEIVES frames + control; it never
 * sends pointer/keyboard/clipboard/anything but start/stop control. */

import type { ShadowCryptoBackend } from '@maestro/realtime/shadowCrypto';
import {
  ScreenFrameReceiver,
  decodeScreenControl,
  decodeStreamNonce,
  deriveScreenStreamKey,
  freshStreamNonce,
  signScreenControl,
  verifyScreenControl,
  isRelayTeardownControl,
  SHADOW_SCREEN_STREAM_MAX_TTL_MS,
  type ScreenControlMessage,
  type ScreenControlBinding,
  type ScreenControlSignatureEnvelope,
  type ScreenStreamBinding,
  type ShadowScreenCodec,
} from '@maestro/realtime/shadowScreenStream';

export type ScreenClientPhase =
  | 'idle'
  | 'requesting'
  | 'live'
  | 'permission-required'
  | 'permission-denied'
  | 'busy'
  | 'source-lost'
  | 'source-required'
  | 'error'
  | 'stopped'
  | 'revoked'
  | 'expired'
  | 'offline';

export interface DecodedScreenFrame {
  readonly bytes: Uint8Array;
  readonly codec: ShadowScreenCodec;
  readonly width: number;
  readonly height: number;
  readonly seq: number;
  readonly capturedAtMs: number;
}

export interface ScreenClientState {
  readonly phase: ScreenClientPhase;
  readonly sourceLabel: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly reason: string | null;
  readonly latestFrame: DecodedScreenFrame | null;
  readonly framesDecoded: number;
}

export interface ScreenClientIdentity {
  readonly accountId: string;
  readonly hostDeviceId: string;
  readonly controllerDeviceId: string;
  readonly grantId: string;
  readonly scopeId: string;
  readonly epoch: number;
  readonly leaseId: string;
  readonly leaseExpiresAt: number;
  readonly sourcePolicyId: string;
  readonly requestedCodec: ShadowScreenCodec;
  readonly requestedMaxDimension: number;
  readonly requestedFps: number;
}

export interface ScreenClientLink {
  sendControl(msg: ScreenControlMessage): void;
  onControl(cb: (raw: unknown) => void): void;
  onFrame(cb: (envelope: Uint8Array) => void): void;
  onDisconnect(cb: () => void): void;
}

export interface ScreenClientDeps {
  readonly backend: ShadowCryptoBackend;
  readonly controllerAgreementPrivate: Uint8Array;
  readonly hostAgreementPublic: Uint8Array;
  /** H1: the controller's enrolled Ed25519 signing key — signs start/stop. */
  readonly controllerSigningPrivate: Uint8Array;
  readonly controllerSigningKeyId: string;
  /** H1: the host's enrolled Ed25519 signing PUBLIC key — verifies host controls. */
  readonly hostSigningPublic: Uint8Array;
  readonly identity: ScreenClientIdentity;
  readonly link: ScreenClientLink;
  now(): number;
  newStreamId(): string;
  onState(state: ScreenClientState): void;
}

const IDLE_STATE: ScreenClientState = {
  phase: 'idle', sourceLabel: null, width: null, height: null, fps: null, reason: null, latestFrame: null, framesDecoded: 0,
};

export class ScreenStreamClient {
  private state: ScreenClientState = IDLE_STATE;
  private streamId: string | null = null;
  private controllerNonce: { bytes: Uint8Array; b64: string } | null = null;
  private receiver: ScreenFrameReceiver | null = null;
  private expiresAt = 0;
  private started = false;
  /** Per-stream control-nonce replay cache for verifying HOST controls (H1). */
  private seenControlNonces = new Set<string>();

  constructor(private readonly deps: ScreenClientDeps) {}

  private controlBinding(streamId: string): ScreenControlBinding {
    const id = this.deps.identity;
    return {
      accountId: id.accountId, hostDeviceId: id.hostDeviceId, controllerDeviceId: id.controllerDeviceId,
      grantId: id.grantId, scopeId: id.scopeId, epoch: id.epoch, leaseId: id.leaseId,
      // leaseExpiresAt gates ONLY the local `verifyScreenControl` freshness check — it is NOT
      // part of the signed control transcript (only leaseId is), so host and controller need
      // not agree on the exact value. The material's leaseExpiresAt is frozen at attach time
      // (a short bootstrap window) and the host renews its lease forward without changing the
      // leaseId, so once the app has been open past that window EVERY host accept was rejected
      // `lease-expired` → the viewer got stuck on "Retry". Recompute a fresh forward window on
      // each call so the check always passes while the controller is online; the host remains
      // authoritative and caps the real stream lifetime via the accept's expiresAt.
      leaseExpiresAt: Math.max(id.leaseExpiresAt, this.deps.now() + SHADOW_SCREEN_STREAM_MAX_TTL_MS), streamId,
    };
  }

  getState(): ScreenClientState {
    return this.state;
  }

  private set(patch: Partial<ScreenClientState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  /** Wire the transport once. */
  private ensureWired(): void {
    if (this.started) return;
    this.started = true;
    this.deps.link.onControl((raw) => { void this.onControl(raw); });
    this.deps.link.onFrame((env) => { void this.onFrame(env); });
    this.deps.link.onDisconnect(() => { this.teardown('offline', 'connection lost'); });
  }

  /** User taps "View screen": sign + send a start request. */
  requestView(): void {
    this.ensureWired();
    void this.doRequestView();
  }

  private async doRequestView(): Promise<void> {
    // Reset any prior frame/key + replay cache (fresh stream).
    this.disposeReceiver();
    this.seenControlNonces = new Set<string>();
    const streamId = this.deps.newStreamId();
    const nonce = freshStreamNonce(this.deps.backend);
    this.streamId = streamId;
    this.controllerNonce = nonce;
    const now = this.deps.now();
    const id = this.deps.identity;
    this.set({ phase: 'requesting', reason: null, latestFrame: null });
    const start: ScreenControlMessage = {
      kind: 'screen-start', v: 1, streamId,
      accountId: id.accountId, hostDeviceId: id.hostDeviceId, controllerDeviceId: id.controllerDeviceId,
      grantId: id.grantId, scopeId: id.scopeId, epoch: id.epoch, leaseId: id.leaseId, sourcePolicyId: id.sourcePolicyId,
      requestedCodec: id.requestedCodec, requestedMaxDimension: id.requestedMaxDimension, requestedFps: id.requestedFps,
      controllerNonce: nonce.b64, requestedAt: now, expiresAt: now + SHADOW_SCREEN_STREAM_MAX_TTL_MS,
    };
    // H1: Ed25519-sign the start with the enrolled controller key; the host verifies
    // it before any capture.
    const signed = await signScreenControl(this.deps.backend, this.deps.controllerSigningPrivate, {
      role: 'controller', signerKeyId: this.deps.controllerSigningKeyId, controlNonce: freshStreamNonce(this.deps.backend).b64, message: start, binding: this.controlBinding(streamId),
    });
    if (this.streamId !== streamId) return; // superseded while signing
    this.deps.link.sendControl(signed);
  }

  /** Local stop (user, foreground exit, route change). Signs + sends stop + clears. */
  stop(reason = 'stopped by viewer'): void {
    const streamId = this.streamId;
    if (streamId) {
      const base: ScreenControlMessage = { kind: 'screen-stop', v: 1, streamId, reason, at: this.deps.now() };
      // H1: sign the controller stop so the host verifies it (best-effort — local
      // teardown happens regardless so the viewer stops immediately).
      void signScreenControl(this.deps.backend, this.deps.controllerSigningPrivate, {
        role: 'controller', signerKeyId: this.deps.controllerSigningKeyId, controlNonce: freshStreamNonce(this.deps.backend).b64, message: base, binding: this.controlBinding(streamId),
      }).then((signed) => { try { this.deps.link.sendControl(signed); } catch { /* */ } }).catch(() => { /* */ });
    }
    this.teardown('stopped', reason);
  }

  private async onControl(raw: unknown): Promise<void> {
    const decoded = decodeScreenControl(raw, { nowMs: this.deps.now() });
    try { console.log(`[DIAG4] RECV ctrl decodedOk=${decoded.ok}${decoded.ok ? ' kind=' + (decoded.message as {kind?:string}).kind + ' sid=' + ((decoded.message as {streamId?:string}).streamId ?? '-').slice(0,10) + ' mine=' + (this.streamId ?? '-').slice(0,10) : ''}`); } catch { /* */ }
    if (!decoded.ok) return;
    const msg = decoded.message as ScreenControlMessage & ScreenControlSignatureEnvelope;

    // Transport-local relay teardown (unsigned) → conservative STOP only.
    if (isRelayTeardownControl(msg)) { this.teardown('offline', msg.kind === 'screen-stop' ? msg.reason : 'connection lost'); return; }

    // Every AUTHORITATIVE host control must be signed by the enrolled host key + match
    // the current stream binding before it changes any live/authoritative state (H1).
    if (!this.streamId || msg.streamId !== this.streamId) return;
    const v = await verifyScreenControl(this.deps.backend, this.deps.hostSigningPublic, 'host', msg, this.controlBinding(this.streamId), { nowMs: this.deps.now(), seenControlNonces: this.seenControlNonces });
    if (!v.ok) return; // forged/unsigned/replayed host control → ignored, no state change

    try { console.log(`[DIAG4] onControl kind=${(msg as {kind?:string}).kind} verifyOk=${v.ok} status=${(msg as {status?:string}).status ?? '-'} reason=${(msg as {reason?:string}).reason ?? '-'}`); } catch { /* */ }
    if (msg.kind === 'screen-accept') { await this.onAccept(msg); return; }
    if (msg.kind === 'screen-status') { this.onStatus(msg.status, msg.reason, msg.fps); return; }
    if (msg.kind === 'screen-stop') { this.teardown('stopped', msg.reason); return; }
  }

  private async onAccept(msg: Extract<ScreenControlMessage, { kind: 'screen-accept' }>): Promise<void> {
    if (!this.streamId || msg.streamId !== this.streamId || !this.controllerNonce) return;
    const id = this.deps.identity;
    const binding: ScreenStreamBinding = {
      streamId: this.streamId,
      accountId: id.accountId,
      hostDeviceId: id.hostDeviceId,
      controllerDeviceId: id.controllerDeviceId,
      grantId: id.grantId,
      scopeId: id.scopeId,
      epoch: id.epoch,
      leaseId: id.leaseId,
      leaseExpiresAt: id.leaseExpiresAt,
      sourcePolicyId: msg.sourcePolicyId,
      codec: msg.codec,
      width: msg.width,
      height: msg.height,
    };
    const hostNonce = decodeStreamNonce(msg.hostNonce);
    let key: Uint8Array;
    try {
      key = await deriveScreenStreamKey({
        backend: this.deps.backend,
        selfAgreementPrivate: this.deps.controllerAgreementPrivate,
        peerAgreementPublic: this.deps.hostAgreementPublic,
        hostNonce,
        controllerNonce: this.controllerNonce.bytes,
        binding,
        keyEpoch: msg.keyEpoch,
      });
    } catch {
      this.teardown('error', 'key derivation failed');
      return;
    }
    this.expiresAt = msg.expiresAt;
    this.receiver = new ScreenFrameReceiver(this.deps.backend, key, binding, msg.keyEpoch, { expiresAtMs: msg.expiresAt });
    // NOTE: do NOT flip to 'live' yet — only after the first authenticated frame.
    this.set({ sourceLabel: msg.sourceLabel, width: msg.width, height: msg.height, fps: msg.fps, reason: null });
  }

  private onStatus(status: string, reason?: string, fps?: number): void {
    switch (status) {
      case 'permission-required': this.teardown('permission-required', reason); break;
      case 'permission-denied': this.teardown('permission-denied', reason); break;
      case 'busy': this.teardown('busy', reason); break;
      case 'source-lost': this.teardown('source-lost', reason); break;
      case 'source-required': this.teardown('source-required', reason); break;
      case 'revoked': this.teardown('revoked', reason); break;
      case 'expired': this.teardown('expired', reason); break;
      case 'error': this.teardown('error', reason); break;
      case 'stopped': this.teardown('stopped', reason); break;
      case 'live': if (fps) this.set({ fps }); break; // stay 'requesting' until first frame
      case 'starting': break;
      default: break;
    }
  }

  // Latest-frame-only pipeline. Decrypt+decode+render is slower than a 30fps arrival rate
  // on the JS thread, so processing EVERY frame builds an ever-growing backlog — the viewer
  // falls seconds behind (looks "static", updates late). Instead we keep ONLY the newest
  // envelope and decode it as soon as the previous one finishes, DROPPING everything in
  // between. That decouples arrival rate from render rate → the screen always shows the most
  // recent frame with sub-second latency (AnyDesk-style), no matter how fast the host sends.
  private pendingEnvelope: Uint8Array | null = null;
  private frameDraining = false;

  private onFrame(envelope: Uint8Array): void {
    this.pendingEnvelope = envelope; // overwrite: only the latest matters
    if (this.frameDraining) return;
    void this.drainFrames();
  }

  private async drainFrames(): Promise<void> {
    this.frameDraining = true;
    try {
      while (this.pendingEnvelope) {
        const envelope = this.pendingEnvelope;
        this.pendingEnvelope = null;
        const r = this.receiver;
        if (!r) break;
        const res = await r.accept(envelope, this.deps.now());
        if (!res.ok) continue; // replay/tamper/expired → drop, keep draining
        // Zero the previous frame's bytes before replacing (no history retained).
        const prev = this.state.latestFrame;
        if (prev) prev.bytes.fill(0);
        this.set({
          phase: 'live',
          reason: null,
          latestFrame: { bytes: res.frameBytes, codec: res.meta.codec, width: res.meta.width, height: res.meta.height, seq: res.meta.seq, capturedAtMs: res.meta.captureTsMs },
          framesDecoded: this.state.framesDecoded + 1,
        });
      }
    } finally {
      this.frameDraining = false;
    }
  }

  private teardown(phase: ScreenClientPhase, reason?: string): void {    this.disposeReceiver();
    const prev = this.state.latestFrame;
    if (prev) prev.bytes.fill(0);
    this.streamId = null;
    this.controllerNonce = null;
    this.set({ phase, reason: reason ?? null, latestFrame: null });
  }

  private disposeReceiver(): void {
    if (this.receiver) { this.receiver.dispose(); this.receiver = null; }
  }
}
