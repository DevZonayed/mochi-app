/* shadowScreenViewerStore — Phase 3D1 observable store bridging the pure
 * `ScreenStreamClient` (crypto/transport) to the RN Screen viewer. It owns the
 * authority inputs (screen.view granted? / online?), the latest decoded frame as a
 * standard base64 JPEG data URI (rebuilt on each frame, previous dropped), and the
 * derived `ScreenViewModel`. It holds NO durable cache and NEVER writes a frame to
 * disk. A production `ScreenStreamClient` is attached via `attach()`; without one
 * the store still renders the truthful no-cap/offline/idle/terminal states. */

import { deriveScreenViewModel, type ScreenViewModel } from './shadowScreenUiModel';
import type { ScreenClientState } from './shadowScreenClient';

const IDLE_CLIENT: ScreenClientState = {
  phase: 'idle', sourceLabel: null, width: null, height: null, fps: null, reason: null, latestFrame: null, framesDecoded: 0,
};

/** The subset of ScreenStreamClient the store drives (keeps the store testable). */
export interface ScreenViewerClient {
  requestView(): void;
  stop(reason?: string): void;
}

export interface ScreenViewerSnapshot {
  readonly vm: ScreenViewModel;
  readonly frameDataUri: string | null;
}

const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Std(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += STD_B64[(n >>> 18) & 63]! + STD_B64[(n >>> 12) & 63]! + STD_B64[(n >>> 6) & 63]! + STD_B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) { const n = bytes[i]! << 16; out += STD_B64[(n >>> 18) & 63]! + STD_B64[(n >>> 12) & 63]! + '=='; }
  else if (rem === 2) { const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8); out += STD_B64[(n >>> 18) & 63]! + STD_B64[(n >>> 12) & 63]! + STD_B64[(n >>> 6) & 63]! + '='; }
  return out;
}

export class ScreenViewerStore {
  private granted = false;
  private online = false;
  private hostName = 'your Mac';
  private configuredSourceLabel: string | null = null;
  private client: ScreenClientState = IDLE_CLIENT;
  private frameDataUri: string | null = null;
  private attached: ScreenViewerClient | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: ScreenViewerSnapshot;

  constructor() {
    this.snapshot = this.compute();
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = (): ScreenViewerSnapshot => this.snapshot;

  /** Update the authority inputs (from the durable controller projection). */
  setAuthority(input: { screenViewGranted: boolean; online: boolean; hostName?: string; configuredSourceLabel?: string | null }): void {
    this.granted = input.screenViewGranted;
    this.online = input.online;
    if (input.hostName) this.hostName = input.hostName;
    if (input.configuredSourceLabel !== undefined) this.configuredSourceLabel = input.configuredSourceLabel;
    this.recompute();
  }

  /** Attach a live client (production). Its onState feeds this store. Detaching (null)
   * returns to idle so a stale frame never lingers after the client is torn down. */
  attach(client: ScreenViewerClient | null): void {
    this.attached = client;
    if (!client) { this.client = IDLE_CLIENT; this.frameDataUri = null; }
    this.recompute();
  }

  /** True once a live production client is attached (drives the View button + tests). */
  isAttached(): boolean { return this.attached !== null; }

  /** Called by the runtime whenever the client's state changes. */
  onClientState(state: ScreenClientState): void {
    // Drop/replace the previous frame's data URI (no history retained).
    if (state.latestFrame) {
      this.frameDataUri = `data:image/${state.latestFrame.codec === 'webp' ? 'webp' : 'jpeg'};base64,${base64Std(state.latestFrame.bytes)}`;
    } else {
      this.frameDataUri = null;
    }
    this.client = state;
    this.recompute();
  }

  /** Start a stream. If NO client is attached yet (the runtime hasn't wired one for the
   * current grant/session), this is NOT a silent no-op: it surfaces a truthful
   * `source-required`-adjacent error so the tap is never swallowed. In practice the View
   * button is hidden until attached (see the view model), so this is a defensive guard. */
  requestView(): void {
    if (this.attached) { this.attached.requestView(); return; }
    this.client = { ...IDLE_CLIENT, phase: 'error', reason: 'not connected yet' };
    this.frameDataUri = null;
    this.recompute();
  }
  stop(reason = 'stopped by viewer'): void {
    this.attached?.stop(reason);
    if (!this.attached) { this.client = IDLE_CLIENT; this.frameDataUri = null; this.recompute(); }
  }

  private compute(): ScreenViewerSnapshot {
    const vm = deriveScreenViewModel({
      screenViewGranted: this.granted,
      online: this.online,
      client: this.client,
      hostName: this.hostName,
      configuredSourceLabel: this.configuredSourceLabel,
      attached: this.attached !== null,
    });
    return { vm, frameDataUri: vm.showFrame ? this.frameDataUri : null };
  }

  private recompute(): void {
    this.snapshot = this.compute();
    for (const fn of this.listeners) fn();
  }
}
