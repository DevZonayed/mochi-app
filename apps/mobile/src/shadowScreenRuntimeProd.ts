/* shadowScreenRuntimeProd — Phase 3D1 (B1) production wiring for the mobile screen
 * runtime owner. Constructs the singleton `ScreenRuntime` with the REAL production
 * deps: the enrolled `ShadowMobileEnrollmentRuntime` (screen key material +
 * `screen.view` verification), the durable session (server + token + device + active
 * host), the RN global `WebSocket` pointed at `/ws/remote/screen`, and the viewer
 * store. Called once from `App.tsx` boot. RN/expo imports live here so
 * `shadowScreenRuntime.ts` stays platform-free + unit-testable. */

import * as Crypto from 'expo-crypto';
import { ScreenRuntime, type ScreenWsLike } from './shadowScreenRuntime';
import { getScreenViewerStore } from './screens/controller/ScreenViewer';
import { nobleShadowCrypto } from './shadowCryptoNoble';
import { getShadowMobileEnrollmentRuntime } from './shadowEnrollmentRuntimeFactory';
import { API_BASE, getSessionToken, getDeviceId, getActiveHost, isAuthed, subscribeSession, subscribeActiveHost } from './auth';
import { SHADOW_SCREEN_VIEW_CAPABILITY } from '@maestro/realtime/shadowCapabilities';

function expoRandomSource(length: number): Uint8Array {
  return Crypto.getRandomBytes(length);
}

let singleton: ScreenRuntime | null = null;

/** Construct + start the production screen runtime owner (idempotent). */
export function getShadowScreenRuntime(): ScreenRuntime {
  if (singleton) return singleton;
  const backend = nobleShadowCrypto(expoRandomSource);
  singleton = new ScreenRuntime({
    backend,
    store: getScreenViewerStore(),
    getMaterial: async () => {
      try { return await (await getShadowMobileEnrollmentRuntime()).screenClientMaterial(); } catch { return null; }
    },
    isScreenViewGranted: async () => {
      try {
        const caps = await (await getShadowMobileEnrollmentRuntime()).verifiedApprovedCapabilities();
        return !!caps && caps.includes(SHADOW_SCREEN_VIEW_CAPABILITY);
      } catch { return false; }
    },
    session: () => {
      const host = getActiveHost();
      if (!isAuthed() || !host) return null;
      return { relayOrigin: API_BASE, sessionToken: getSessionToken(), deviceId: getDeviceId(), hostId: host };
    },
    isOnline: () => isAuthed() && !!getActiveHost(),
    hostName: () => 'your Mac',
    createWs: (url: string) => {
      const ws = new WebSocket(url) as unknown as ScreenWsLike & { binaryType?: string };
      try { ws.binaryType = 'arraybuffer'; } catch { /* */ }
      return ws;
    },
    subscribeSession,
    subscribeActiveHost,
    // B1-R1: bridge the enrollment runtime's grant-change events. Returns an unsubscribe
    // immediately; the real subscription attaches once the (promise-memoized) runtime
    // resolves. This fires on restore / fresh accept / renew / revoke / purge — the flows
    // where session/host don't change — so the client attaches exactly when the grant lands.
    subscribeGrant: (cb: () => void) => {
      let unsub: (() => void) | null = null;
      let cancelled = false;
      void getShadowMobileEnrollmentRuntime()
        .then((rt) => { if (!cancelled) unsub = rt.subscribeGrant(cb); })
        .catch(() => { /* unavailable → no grant events; refresh still runs on session/host */ });
      return () => { cancelled = true; if (unsub) { unsub(); unsub = null; } };
    },
    now: Date.now,
    newStreamId: () => `scr_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`,
  });
  singleton.start();
  return singleton;
}

/** Test/lifecycle hook: detach + drop the singleton (used on hard sign-out flows). */
export function resetShadowScreenRuntime(): void {
  if (singleton) { try { singleton.detach(); } catch { /* */ } }
  singleton = null;
}
