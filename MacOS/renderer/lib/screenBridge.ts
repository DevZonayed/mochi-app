/* screenBridge — Phase 3D1 (B2) renderer boot module. Defines the globals Swift calls
 * for native ScreenCaptureKit frames (`window.__maestroScreenFrame`) and errors, and
 * relays the latest frame to the brain over the authenticated loopback bridge
 * (`api.call('screenFrame', …)`). It also drives native capture start/stop in response
 * to the brain coordinator's control events, and reports the (non-prompting) Screen
 * Recording permission + the host-confirmed configured display source up to the brain.
 * Runs once at boot (mirrors startDesktopP2P). Inert without window.maestro (web). */

interface NativeBridge {
  call(method: string, params: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>;
  onEvent(cb: (e: { name: string; data: unknown }) => void): () => void;
  screenCapturePreflight?: () => Promise<{ ok: boolean; permission?: string }>;
  screenCaptureListSources?: () => Promise<{ ok: boolean; sources?: Array<{ id: string; label: string; width: number; height: number }> }>;
  screenCaptureStart?: (p: Record<string, unknown>) => Promise<{ ok: boolean; width?: number; height?: number; error?: string }>;
  screenCaptureStop?: () => Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    maestro?: NativeBridge;
    __maestroScreenFrame?: (b64: string, ts: number) => void;
    __maestroScreenError?: (reason: string) => void;
  }
}

/** Install the screen bridge. Called once from renderer boot. */
export function startScreenBridge(): void {
  if (typeof window === 'undefined') return;
  const bridge = window.maestro;
  if (!bridge || typeof bridge.call !== 'function') return; // web/phone remote — no native capture

  // Swift → renderer: forward each latest native JPEG frame to the brain (latest-only;
  // never queued/persisted here — a single in-flight call, bounded size).
  let inFlight = false;
  window.__maestroScreenFrame = (b64: string, ts: number) => {
    if (inFlight || typeof b64 !== 'string' || b64.length === 0 || b64.length > 2_000_000) return;
    inFlight = true;
    bridge.call('screenFrame', { b64, ts }).catch(() => {}).finally(() => { inFlight = false; });
  };
  window.__maestroScreenError = (reason: string) => { void bridge.call('screenCaptureError', { reason: String(reason).slice(0, 120) }); };

  // Brain coordinator → renderer → native: start/stop capture through the WebKit bridge.
  bridge.onEvent((e) => {
    if (e.name === 'screen-capture-start') {
      const p = (e.data ?? {}) as Record<string, unknown>;
      void bridge.screenCaptureStart?.(p).then((r) => { if (r && !r.ok) window.__maestroScreenError?.(r.error ?? 'start failed'); });
    } else if (e.name === 'screen-capture-stop') {
      void bridge.screenCaptureStop?.();
    }
  });

  // Report the (non-prompting) permission + the CURRENTLY-available display ids up to the
  // brain. M-A: we do NOT auto-configure a source here — the operator must explicitly
  // confirm a display in the Controllers "Screen sharing" card. Reporting the ids lets the
  // brain REVALIDATE a previously-confirmed display (dropping it if it's gone) without ever
  // auto-picking one. No window titles/app names are ever enumerated (displays only).
  void (async () => {
    try {
      const pf = await bridge.screenCapturePreflight?.();
      if (pf) await bridge.call('screenPermission', { permission: pf.permission ?? 'undetermined' });
      const srcs = await bridge.screenCaptureListSources?.();
      const ids = (srcs?.sources ?? []).map((s) => s.id);
      await bridge.call('screenReportSources', { ids });
    } catch { /* best-effort; the Screen tab surfaces truthful unavailable states */ }
  })();
}
