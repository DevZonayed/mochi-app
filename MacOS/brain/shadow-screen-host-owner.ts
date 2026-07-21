/* shadow-screen-host-owner — Phase 3D1 (correction B2) PRODUCTION host owner. This is
 * the missing seam the reviewer flagged: it CONSTRUCTS `ScreenStreamHostCoordinator`
 * with LIVE authority + host key material, opens an authenticated `/ws/host/screen`
 * relay link, drives the native ScreenCaptureKit adapter (start/stop) through the
 * WebKit bridge via renderer events, receives each latest native JPEG frame over the
 * loopback IPC seam, seals + relays it, and writes the `screenShareRegistry` status +
 * stop callback. Tears down + zeroes on stop/revoke/authority-change/relay-loss.
 *
 * Everything IO-shaped is injected (relay dial, native control emit, registry, clock)
 * so the owner is unit-testable from a headless-startup-style boundary. */

import type { ShadowCryptoBackend } from '@maestro/realtime/shadowCrypto';
import {
  ScreenStreamHostCoordinator,
  type CaptureStartOptions,
  type CaptureStartResult,
  type ScreenAuditEntry,
  type ScreenCaptureAdapter,
  type ScreenRelayLink,
} from './shadow-screen-host.js';
import type { ScreenAuthoritySnapshot, ScreenSourcePolicy } from '@maestro/realtime/shadowScreenStream';
import { freshStreamNonce } from '@maestro/realtime/shadowScreenStream';
import type { ScreenShareRegistry } from './shadow-screen-registry.js';

/** The host's live authority + key access, composed from the enrollment runtime. */
export interface ScreenHostAuthorityProvider {
  /** The full authority snapshot for the coordinator (fence/lease/caps/online/source/foreground). */
  snapshot(controllerDeviceId: string): ScreenAuthoritySnapshot | null;
  hostAgreementPrivate(): Uint8Array | null;
  hostSigningPrivate(): Uint8Array | null;
  hostSigningKeyId(): string | null;
  controllerAgreementPublic(controllerDeviceId: string): Uint8Array | null;
  controllerSigningPublic(controllerDeviceId: string): Uint8Array | null;
  sourcePolicy(): ScreenSourcePolicy | null;
}

/** Drives the native ScreenCaptureKit bridge (through the renderer/WebKit bridge).
 * B2-R1: the native start payload uses the CANONICAL bridge field `sourceId` — the exact
 * key `main.swift` reads and `ScreenCaptureController.Config.sourceID` matches against
 * `SCShareableContent` display ids. There is no `sourcePolicyId` alias on this seam. */
export interface NativeCaptureControl {
  /** Last permission the renderer reported from the public non-prompting preflight. */
  permission(): 'granted' | 'denied' | 'undetermined';
  /** Emit a start to the renderer → native `screenCaptureStart`. `sourceId` is the
   * confirmed display id (e.g. `display:1`) and MUST be non-empty (validated by the
   * caller — the native side additionally rejects an empty id). */
  start(opts: { sourceId: string; codec: string; maxDimension: number; fps: number }): void;
  /** Emit a stop to the renderer → native `screenCaptureStop`. */
  stop(): void;
}

export interface ScreenHostOwnerDeps {
  readonly backend: ShadowCryptoBackend;
  readonly authority: ScreenHostAuthorityProvider;
  readonly native: NativeCaptureControl;
  readonly registry: ScreenShareRegistry;
  /** Open an authenticated `/ws/host/screen` relay link (a `ws` client). */
  dialRelay(): ScreenRelayLink;
  now(): number;
  audit(entry: ScreenAuditEntry): void;
}

/** Aspect-fit the configured source into <=1280 (mirrors the Swift adapter). */
function fitDims(w: number, h: number, maxDim: number): { width: number; height: number } {
  const cap = Math.max(64, Math.min(maxDim, 1280));
  const scale = Math.min(1, cap / Math.max(w, h));
  return { width: Math.max(16, Math.round(w * scale)), height: Math.max(16, Math.round(h * scale)) };
}

export class ScreenHostOwner {
  private coord: ScreenStreamHostCoordinator | null = null;
  private link: ScreenRelayLink | null = null;
  private frameSink: ((bytes: Uint8Array, ts: number) => void) | null = null;
  private errorSink: ((reason: string) => void) | null = null;
  private started = false;

  constructor(private readonly deps: ScreenHostOwnerDeps) {}

  /** Open the relay + construct the coordinator so the host can accept streams. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const link = this.deps.dialRelay();
    this.link = link;

    // The capture adapter bridges the coordinator ↔ the native ScreenCaptureKit path.
    const capture: ScreenCaptureAdapter = {
      preflightPermission: async () => this.deps.native.permission(),
      isSourceAvailable: async (sourcePolicyId) => {
        const s = this.deps.authority.sourcePolicy();
        return !!s && s.sourcePolicyId === sourcePolicyId;
      },
      start: async (opts: CaptureStartOptions): Promise<CaptureStartResult> => {
        const s = this.deps.authority.sourcePolicy();
        // B2-R1: strictly reject a missing/empty configured source BEFORE dialing native.
        // No confirmed display → `source-required` (host must confirm one); a request for a
        // source ≠ the confirmed one → `source-lost` (stale/forged). Never a silent empty id.
        if (!s || !s.sourcePolicyId) return { ok: false, reason: 'source-required' };
        if (s.sourcePolicyId !== opts.sourcePolicyId) return { ok: false, reason: 'source-lost' };
        this.frameSink = opts.onFrame;
        this.errorSink = opts.onError;
        // Map the confirmed source-policy id into the CANONICAL native bridge field `sourceId`.
        this.deps.native.start({ sourceId: s.sourcePolicyId, codec: opts.codec, maxDimension: opts.maxDimension, fps: opts.fps });
        return { ok: true, ...fitDims(s.width, s.height, opts.maxDimension) };
      },
      stop: async () => {
        this.frameSink = null; this.errorSink = null;
        this.deps.native.stop();
      },
    };

    const coord = new ScreenStreamHostCoordinator({
      backend: this.deps.backend,
      hostAgreementPrivate: this.deps.authority.hostAgreementPrivate() ?? new Uint8Array(32),
      hostSigningPrivate: this.deps.authority.hostSigningPrivate() ?? new Uint8Array(32),
      hostSigningKeyId: this.deps.authority.hostSigningKeyId() ?? 'sk_host',
      resolveControllerAgreementPublic: (id) => this.deps.authority.controllerAgreementPublic(id),
      resolveControllerSigningPublic: (id) => this.deps.authority.controllerSigningPublic(id),
      // H1-R2: the coordinator supplies the EXACT requesting controller id; forward it
      // straight to the scoped provider (null → no grant → coordinator fails closed).
      authoritySnapshot: (controllerDeviceId) => this.deps.authority.snapshot(controllerDeviceId),
      sourcePolicy: () => this.deps.authority.sourcePolicy(),
      capture,
      link,
      now: this.deps.now,
      randomNonce: () => freshStreamNonce(this.deps.backend),
      audit: this.deps.audit,
      onShareStatus: (status) => {
        if (status && status.active) this.deps.registry.set(status);
        else this.deps.registry.clear();
      },
    });
    this.coord = coord;
    // The operator's "Stop sharing" (banner / Controllers pane) tears the stream down.
    this.deps.registry.registerStop(() => coord.stopByHost());
    coord.start();
  }

  /** Called by the loopback frame seam (ws-host `screenFrame`) with the latest native
   * JPEG frame. Validated + forwarded to the coordinator to seal + relay. Latest-only:
   * a frame is dropped if capture isn't active. */
  pushFrame(bytes: Uint8Array, captureTsMs: number): void {
    const sink = this.frameSink;
    if (sink) sink(bytes, captureTsMs);
  }

  /** Called when the renderer reports a native capture error / source loss. */
  pushError(reason: string): void {
    this.errorSink?.(reason);
  }

  /** Re-evaluate authority (call after lease renewal / revoke): stops an in-flight
   * stream whose authority no longer holds. */
  async onAuthorityChanged(): Promise<void> {
    await this.coord?.onAuthorityChanged();
  }

  /** Operator-/lifecycle-initiated stop (sign out / shutdown / revoke). Full teardown:
   * DESTROYS the coordinator (clears the host-wide start-replay guard) — this owner is
   * discarded and rebuilt on the next sign-in, so the guard must not leak across it. */
  async stop(): Promise<void> {
    await this.coord?.destroy();
    this.deps.registry.registerStop(null);
    this.deps.registry.clear();
    this.frameSink = null; this.errorSink = null;
  }
}
