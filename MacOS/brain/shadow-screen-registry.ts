/* shadow-screen-registry — Phase 3D1 in-process host-visible screen-share status.
 *
 * A tiny, process-local registry the host screen coordinator writes on start/stop so
 * the desktop UI (Controllers pane active-viewer row + the global banner) can show
 * "device X is viewing your screen" + an immediate Stop. It holds METADATA ONLY
 * (device label, source label, start time) — NEVER frame bytes or keys. `stop()`
 * invokes the coordinator's registered local stop, which tears the stream down. */

export interface ScreenShareStatus {
  readonly active: boolean;
  readonly deviceLabel: string;
  readonly sourceLabel: string;
  readonly startedAtMs: number;
}

const INACTIVE: ScreenShareStatus = { active: false, deviceLabel: '', sourceLabel: '', startedAtMs: 0 };

export class ScreenShareRegistry {
  private status: ScreenShareStatus = INACTIVE;
  private stopFn: (() => Promise<void> | void) | null = null;

  /** Coordinator calls this on start (active=true) and stop (active=false). */
  set(status: ScreenShareStatus): void { this.status = status.active ? status : INACTIVE; }
  clear(): void { this.status = INACTIVE; }

  /** Coordinator registers its local stop so the operator's "Stop sharing" works. */
  registerStop(fn: (() => Promise<void> | void) | null): void { this.stopFn = fn; }

  get(): ScreenShareStatus { return this.status; }

  async stop(): Promise<{ ok: true }> {
    const fn = this.stopFn;
    if (fn) { try { await fn(); } catch { /* best-effort; the coordinator also self-clears */ } }
    this.status = INACTIVE;
    return { ok: true };
  }
}

/** Process-wide singleton (the host runs one coordinator at a time). */
export const screenShareRegistry = new ScreenShareRegistry();
