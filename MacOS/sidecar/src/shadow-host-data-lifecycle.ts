export type ShadowAuthoritySource = {
  liveAuthority(): {
    fence: unknown;
    leaseExpiresAt: number;
    revokedControllerDeviceIds: readonly string[];
    scopeKeyId?: string | null;
  } | null;
  resumePendingRenewal(): Promise<unknown>;
  renewLease(): Promise<unknown>;
};

export type ShadowDataPlane<Svc extends { close(): void; setAuthority?: (...args: never[]) => void }> = {
  accountId: string;
  svc: Svc;
  projection: { close(): void; setFence?(fence: unknown): void } | null;
};

export type ShadowHostDataLifecycleOptions<Svc extends { close(): void; setAuthority?: (...args: never[]) => void }> = {
  renewBeforeMs: number;
  intervalMs: number;
  getAccountId: () => Promise<string>;
  getRuntime: () => Promise<ShadowAuthoritySource>;
  ensureStarted: (rt: ShadowAuthoritySource) => Promise<void>;
  dataPlaneUnavailableReason: (rt: ShadowAuthoritySource) => string | null;
  buildPlane: (rt: ShadowAuthoritySource, accountId: string) => ShadowDataPlane<Svc> | null;
  bindProjection: (plane: ShadowDataPlane<Svc>) => void;
  unbindProjection: () => void;
  onAuthorityChanged?: () => void | Promise<void>;
  onLoopService: (svc: Svc) => Promise<void>;
  warn: (label: string, error: unknown) => void;
  now?: () => number;
};

export class ShadowHostDataLifecycle<Svc extends { close(): void; setAuthority?: (...args: never[]) => void }> {
  private plane: ShadowDataPlane<Svc> | null = null;
  private generation = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ShadowHostDataLifecycleOptions<Svc>) {}

  currentPlaneForTest(): ShadowDataPlane<Svc> | null {
    return this.plane;
  }

  currentGenerationForTest(): number {
    return this.generation;
  }

  async getService(): Promise<Svc | null> {
    return this.run(async () => {
      const accountId = await this.options.getAccountId();
      const rt = await this.options.getRuntime();
      await this.options.ensureStarted(rt);
      if (this.plane && this.plane.accountId === accountId) {
        const reason = this.options.dataPlaneUnavailableReason(rt);
        if (!reason) return this.plane.svc;
        this.closePlane();
      }
      const plane = this.options.buildPlane(rt, accountId);
      if (!plane) return null;
      this.closePlane();
      this.options.bindProjection(plane);
      this.plane = plane;
      this.generation += 1;
      return plane.svc;
    });
  }

  async stop(options: { stopTimer?: boolean } = {}): Promise<void> {
    if (options.stopTimer !== false && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.run(() => this.closePlane());
  }

  applyLiveAuthority(rt: ShadowAuthoritySource): void {
    const plane = this.plane;
    const generation = this.generation;
    if (!plane) return;
    const authority = rt.liveAuthority();
    if (!authority) return;
    if (plane !== this.plane || generation !== this.generation) return;
    if (typeof plane.svc.setAuthority !== 'function') return;
    plane.svc.setAuthority(
      authority.fence as never,
      authority.leaseExpiresAt as never,
      authority.revokedControllerDeviceIds as never,
      (authority.scopeKeyId ?? undefined) as never,
    );
    plane.projection?.setFence?.(authority.fence);
    void this.options.onAuthorityChanged?.();
  }

  async renewLease(): Promise<void> {
    try {
      const planeAtStart = this.plane;
      const generationAtStart = this.generation;
      const rt = await this.options.getRuntime();
      const resumed = await rt.resumePendingRenewal();
      if (resumed) this.applyLiveAuthorityIfCurrent(rt, planeAtStart, generationAtStart);
      const authority = rt.liveAuthority();
      const leaseExpiresAt = authority?.leaseExpiresAt ?? 0;
      if (leaseExpiresAt > 0 && leaseExpiresAt - (this.options.now ?? Date.now)() <= this.options.renewBeforeMs) {
        const renewed = await rt.renewLease();
        if (renewed) this.applyLiveAuthorityIfCurrent(rt, planeAtStart, generationAtStart);
      }
    } catch (e) {
      this.options.warn('shadowHostData.renew', e);
    }
  }

  async onRevoked(rt: ShadowAuthoritySource): Promise<void> {
    await this.run(() => {
      if (!this.plane) return;
      this.applyLiveAuthority(rt);
      this.closePlane();
    });
  }

  async onApproved(rt: ShadowAuthoritySource): Promise<Svc | null> {
    await this.options.ensureStarted(rt);
    if (this.plane) this.applyLiveAuthority(rt);
    return this.getService();
  }

  startLoop(hasSession: () => boolean): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!hasSession()) return;
      void (async () => {
        try {
          const rt = await this.options.getRuntime();
          await this.options.ensureStarted(rt);
          await this.renewLease();
          const svc = await this.getService();
          if (!svc) return;
          await this.options.onLoopService(svc);
        } catch (e) {
          this.options.warn('shadowHostData.loop', e);
        }
      })();
    }, this.options.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  isTimerRunningForTest(): boolean {
    return this.timer !== null;
  }

  private closePlane(): void {
    const plane = this.plane;
    if (!plane) return;
    this.plane = null;
    this.generation += 1;
    try { this.options.unbindProjection(); } catch { /* noop */ }
    try { plane.projection?.close(); } catch { /* noop */ }
    try { plane.svc.close(); } catch { /* noop */ }
  }

  private applyLiveAuthorityIfCurrent(rt: ShadowAuthoritySource, plane: ShadowDataPlane<Svc> | null, generation: number): void {
    if (plane !== this.plane || generation !== this.generation) return;
    this.applyLiveAuthority(rt);
  }

  private async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.lifecycle;
    let release!: () => void;
    this.lifecycle = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => { /* lifecycle errors are handled by the caller */ });
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
