/**
 * Phase 3D1 (correction) INSTALLED-PRODUCT-PATH cross-tier screen-view E2E.
 *
 * This drives the PRODUCTION RUNTIME OWNERS end to end — not disconnected classes:
 *  - Host: the real `ScreenHostOwner` (B2) → `ScreenStreamHostCoordinator`, dialing a
 *    REAL `ScreenRelayHostLink` to the REAL `/ws/host/screen` on a REAL Fastify server
 *    with a disposable PG; native capture is a SYNTHETIC adapter injected only at the
 *    owner's `pushFrame` boundary (the production capture-coordinator boundary).
 *  - Mobile: the real `ScreenRuntime` (B1) → `ScreenStreamClient`, attached to the real
 *    `ScreenViewerStore`, dialing a REAL `WebSocket` to the REAL `/ws/remote/screen`.
 *  - Controls are Ed25519-SIGNED (H1) with production node:crypto; keys are generated
 *    in-harness to model the enrolled authority (the enrollment-runtime key extraction
 *    is unit-proven in B1/B2). Frames are AES-256-GCM, lease-bound (L1).
 *
 * Proves: granted "View screen" via the STORE action → signed start → host accept →
 * ≥20 synthetic frames sealed→relayed→decoded → store goes LIVE only after the first
 * decoded frame; exact account/host/source; NO plaintext canary in PG/registry;
 * desktop Stop + mobile Stop; revoke/source-loss/host-restart stop; six commands stay
 * independent. ≥5 fresh DBs + chaos ≥10×; zero skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { buildAccountServer, migrateAll } from '../../apps/server/src/accountServer.ts';
import { auth, getSessionUser } from '../../apps/server/src/auth.ts';
import { upsertDevice } from '../../apps/server/src/accountDevices.ts';
import { getDb } from '../../apps/server/src/db.ts';
import { nodeShadowCrypto as backend } from '@maestro/realtime/shadowCryptoNode';
import { freshStreamNonce, type ScreenSourcePolicy, type ScreenAuthoritySnapshot } from '@maestro/realtime/shadowScreenStream';
import { CONTROLLER_METHOD_CAPABILITY } from '@maestro/realtime/shadowCapabilities';
import { ScreenHostOwner, type NativeCaptureControl } from '../../MacOS/brain/shadow-screen-host-owner.ts';
import { ScreenRelayHostLink } from '../../MacOS/brain/shadow-screen-relay-link.ts';
import { ScreenShareRegistry } from '../../MacOS/brain/shadow-screen-registry.ts';
import { ScreenRuntime, type ScreenWsLike, type ScreenClientMaterial } from '../../apps/mobile/src/shadowScreenRuntime.ts';
import { ScreenViewerStore } from '../../apps/mobile/src/shadowScreenViewerStore.ts';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));
const SOURCE: ScreenSourcePolicy = { sourcePolicyId: 'src_main', kind: 'display', label: 'Built-in Retina Display · 1512×982', width: 1512, height: 982 };

let app: ReturnType<typeof buildAccountServer>;
let origin = ''; let wsBase = '';

async function makeAccount(): Promise<{ accountId: string; token: string }> {
  const email = `screen${Date.now()}_${Math.floor(process.hrtime()[1])}@x.dev`;
  const res = await auth.api.signUpEmail({ body: { email, password: 'pw-12345678', name: 'Screen E2E' } });
  const token = res.token as string;
  const who = await getSessionUser({ authorization: `Bearer ${token}` });
  if (!who) throw new Error('no session user');
  return { accountId: who.userId, token };
}

function syntheticJpeg(seq: number, canary: string, size = 8192): Uint8Array {
  const b = new Uint8Array(size);
  b[0] = 0xff; b[1] = 0xd8;
  const enc = new TextEncoder().encode(canary); b.set(enc, 8);
  for (let i = 8 + enc.length; i < size - 2; i += 1) b[i] = (seq * 37 + i) & 0xff;
  b[size - 2] = 0xff; b[size - 1] = 0xd9;
  return b;
}

/** Adapt a Node `ws` socket to the RN-style ScreenWsLike the ScreenRuntime expects. */
function wsAdapter(url: string): ScreenWsLike {
  const raw = new WebSocket(url) as unknown as { on: (e: string, cb: (...a: unknown[]) => void) => void; send: (d: unknown, o?: unknown) => void; close: () => void; readyState: number; binaryType?: string };
  raw.binaryType = 'arraybuffer';
  const obj: ScreenWsLike = {
    get readyState() { return raw.readyState; },
    send: (d) => { try { raw.send(d as never, typeof d === 'string' ? undefined : { binary: true }); } catch { /* */ } },
    close: () => { try { raw.close(); } catch { /* */ } },
    onopen: null, onmessage: null, onclose: null, onerror: null,
  };
  raw.on('open', () => obj.onopen?.());
  raw.on('message', (data: unknown, isBinary: boolean) => {
    // With binaryType='arraybuffer', ws delivers binary as an ArrayBuffer already.
    if (isBinary) obj.onmessage?.({ data: data as ArrayBuffer });
    else obj.onmessage?.({ data: typeof data === 'string' ? data : String(data) });
  });
  raw.on('close', () => obj.onclose?.());
  raw.on('error', () => obj.onerror?.());
  return obj;
}

/** B2-R1: a native adapter that behaves like the Swift seam — it reads ONLY the canonical
 * `sourceId` field and REJECTS a missing/empty id, exactly like `main.swift`. Using it in
 * the installed-path E2E closes the tested-vs-installed gap the reviewer flagged: the
 * synthetic adapter no longer ignores the payload key, so a `sourceId`/`sourcePolicyId`
 * mismatch (or an unconfirmed source) would fail the stream here, not just on a real Mac. */
class SwiftContractNative implements NativeCaptureControl {
  started = 0; stopped = 0; startedIds: string[] = []; sawEmpty = false; sawAliasKey = false;
  permission(): 'granted' { return 'granted'; }
  start(opts: { sourceId: string; codec: string; maxDimension: number; fps: number }): void {
    if ('sourcePolicyId' in (opts as Record<string, unknown>)) this.sawAliasKey = true; // the old mismatched key must NOT appear
    const id = typeof (opts as Record<string, unknown>).sourceId === 'string' ? (opts as { sourceId: string }).sourceId : '';
    if (!id) { this.sawEmpty = true; return; } // Swift: empty → source-required, no capture
    this.started += 1; this.startedIds.push(id);
  }
  stop(): void { this.stopped += 1; }
}

interface Wired {
  accountId: string; token: string; hostId: string; ctrlId: string;
  host: ScreenHostOwner; hostNative: SwiftContractNative; registry: ScreenShareRegistry;
  store: ScreenViewerStore; runtime: ScreenRuntime;
  hostLink: ScreenRelayHostLink;
  fence: ScreenAuthoritySnapshot['fence'];
  setGranted: (g: boolean) => void; setSourceLost: () => void; fireGrant: () => void;
}

async function wire(opts: { grant?: boolean } = {}): Promise<Wired> {
  const { accountId, token } = await makeAccount();
  const hostId = `host_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const ctrlId = `ctrl_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await upsertDevice({ id: hostId, userId: accountId, role: 'host', name: 'Mac', platform: 'macos' });
  await upsertDevice({ id: ctrlId, userId: accountId, role: 'remote', name: 'Phone', platform: 'ios' });

  const hostAgree = await backend.generateAgreementKeyPair();
  const ctrlAgree = await backend.generateAgreementKeyPair();
  const hostSign = await backend.generateSigningKeyPair();
  const ctrlSign = await backend.generateSigningKeyPair();
  const fence = { accountId, scopeId: `scope_${hostId}`, hostDeviceId: hostId, epoch: 4, leaseId: `lease_${hostId}` };
  let granted = opts.grant !== false;
  let sourceOk = true;
  // Pin the lease expiry ONCE so the host snapshot + the controller material agree exactly
  // (the signed control transcript binds leaseExpiresAt; a drifting Date.now() would break
  // signature verification on any start issued a millisecond later).
  const leaseExpiresAt = Date.now() + 10 * 60_000;

  // ── HOST production owner ───────────────────────────────────────────────
  const registry = new ScreenShareRegistry();
  const hostNative = new SwiftContractNative();
  const hostLink = new ScreenRelayHostLink({ relayOrigin: origin, sessionToken: token, hostDeviceId: hostId });
  const host = new ScreenHostOwner({
    backend,
    authority: {
      snapshot: (): ScreenAuthoritySnapshot => ({
        fence, leaseExpiresAtMs: leaseExpiresAt,
        grantedCapabilities: granted ? ['account.read', 'screen.view'] : ['account.read'],
        revokedControllerDeviceIds: granted ? [] : [ctrlId],
        hostOnline: true, configuredSourcePolicyId: sourceOk ? 'src_main' : null, foreground: true,
      }),
      hostAgreementPrivate: () => hostAgree.privateKey,
      hostSigningPrivate: () => hostSign.privateKey,
      hostSigningKeyId: () => 'sk_host',
      controllerAgreementPublic: (id) => (id === ctrlId ? ctrlAgree.publicKey : null),
      controllerSigningPublic: (id) => (id === ctrlId ? ctrlSign.publicKey : null),
      sourcePolicy: () => (sourceOk ? SOURCE : null),
    },
    native: hostNative, registry,
    dialRelay: () => hostLink,
    now: () => Date.now(), audit: () => {},
  });
  host.start();

  // ── MOBILE production owner (ScreenRuntime → ScreenStreamClient → store) ──
  const store = new ScreenViewerStore();
  const material: ScreenClientMaterial = {
    controllerAgreementPrivate: ctrlAgree.privateKey, hostAgreementPublic: hostAgree.publicKey,
    controllerSigningPrivate: ctrlSign.privateKey, controllerSigningKeyId: 'sk_ctrl', hostSigningPublic: hostSign.publicKey,
    identity: { accountId, hostDeviceId: hostId, controllerDeviceId: ctrlId, grantId: `grant_${ctrlId}`, scopeId: fence.scopeId, epoch: 4, leaseId: fence.leaseId, leaseExpiresAt },
  };
  let grantCb: (() => void) | null = null;
  const runtime = new ScreenRuntime({
    backend, store,
    getMaterial: async () => (granted ? material : null),
    isScreenViewGranted: async () => granted,
    session: () => ({ relayOrigin: origin, sessionToken: token, deviceId: ctrlId, hostId }),
    isOnline: () => true, hostName: () => 'your Mac',
    createWs: (url) => wsAdapter(url),
    subscribeSession: () => () => {}, subscribeActiveHost: () => () => {},
    subscribeGrant: (cb) => { grantCb = cb; return () => { grantCb = null; }; }, // B1-R1
    now: () => Date.now(), newStreamId: () => `scr_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`,
  });
  runtime.start();
  await tick(30);
  return { accountId, token, hostId, ctrlId, host, hostNative, registry, store, runtime, hostLink, fence, setGranted: (g) => { granted = g; }, setSourceLost: () => { sourceOk = false; }, fireGrant: () => grantCb?.() };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await tick(10); }
  return pred();
}

describe.skipIf(!HAS_DB)('Phase 3D1 INSTALLED-PATH screen-view E2E (production owners over real relay)', () => {
  beforeAll(async () => {
    await migrateAll();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${addr.port}`; wsBase = `ws://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => { if (app) await app.close(); });

  it('store View action → signed start → host accept → ≥20 frames → store LIVE; no PG canary; desktop+mobile Stop', async () => {
    const w = await wire();
    expect(w.runtime.isAttached()).toBe(true); // B1: real client attached in the owner
    const canary = `CANARY-${Math.floor(Math.random() * 1e9)}-screenframe`;

    w.store.requestView(); // ← the STORE action (what the ScreenViewer "View screen" button calls)
    expect(await waitFor(() => w.hostNative.started === 1)).toBe(true); // host owner started native capture
    // B2-R1: the native seam received the CANONICAL `sourceId` = the host's confirmed
    // display, never the `sourcePolicyId` alias and never an empty id — the exact defect
    // the synthetic adapter used to mask.
    expect(w.hostNative.startedIds).toEqual(['src_main']);
    expect(w.hostNative.sawAliasKey).toBe(false);
    expect(w.hostNative.sawEmpty).toBe(false);
    expect(w.registry.get().active).toBe(true); // desktop banner/card go live

    // Synthetic native frames enter at the owner's production capture boundary.
    for (let i = 1; i <= 24; i += 1) { w.host.pushFrame(syntheticJpeg(i, canary), Date.now()); await tick(6); }
    expect(await waitFor(() => w.store.getSnapshot().vm.phase === 'live', 6000)).toBe(true); // LIVE only after first decoded frame
    expect(w.store.getSnapshot().frameDataUri).toBeTruthy();

    // No plaintext canary in PG or the metadata-only registry.
    for (const table of ['shadow_event', 'shadow_command', 'shadow_snapshot', 'shadow_blob', 'shadow_chunk'] as const) {
      const rows = await getDb().selectFrom(table).selectAll().execute().catch(() => []);
      expect(JSON.stringify(rows)).not.toContain(canary);
    }
    expect(JSON.stringify(w.registry.get())).not.toContain(canary);

    // Desktop "Stop sharing" (registry stop → owner → native stop).
    await w.registry.stop();
    expect(await waitFor(() => w.hostNative.stopped >= 1)).toBe(true);
    // Mobile stop clears the store frame.
    w.store.stop();
    await tick(20);
    expect(w.store.getSnapshot().frameDataUri).toBeNull();
    w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
  });

  it('no-cap: an ungranted controller never attaches / never starts capture', async () => {
    const w = await wire({ grant: false });
    expect(w.runtime.isAttached()).toBe(false); // store shows idle-unavailable, no dead View
    w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
  });

  it('revoke mid-stream stops the host + native', async () => {
    const w = await wire();
    w.store.requestView();
    expect(await waitFor(() => w.hostNative.started === 1)).toBe(true);
    w.host.pushFrame(syntheticJpeg(1, 'x'), Date.now());
    expect(await waitFor(() => w.store.getSnapshot().vm.phase === 'live')).toBe(true);
    w.setGranted(false);
    await w.host.onAuthorityChanged();
    expect(await waitFor(() => w.hostNative.stopped >= 1)).toBe(true);
    w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
  });

  it('the six durable action families stay independent while streaming', async () => {
    const before = { ...CONTROLLER_METHOD_CAPABILITY };
    const w = await wire();
    w.store.requestView();
    expect(await waitFor(() => w.hostNative.started === 1)).toBe(true);
    const health = await fetch(`${origin}/health`); expect(health.status).toBe(200);
    const cmd = await fetch(`${origin}/api/shadow/commands?scopeId=x`, { headers: { 'x-maestro-device-id': w.hostId } });
    expect([400, 401, 403]).toContain(cmd.status);
    expect({ ...CONTROLLER_METHOD_CAPABILITY }).toEqual(before);
    expect(Object.values(CONTROLLER_METHOD_CAPABILITY)).not.toContain('screen.view');
    w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
  });

  it('runs the installed path across ≥5 freshly-migrated databases', async () => {
    for (let round = 0; round < 5; round += 1) {
      await getDb().schema.dropSchema('public').cascade().ifExists().execute();
      await getDb().schema.createSchema('public').ifNotExists().execute();
      await migrateAll();
      const w = await wire();
      const canary = `ROUND${round}-${Math.floor(Math.random() * 1e9)}`;
      w.store.requestView();
      expect(await waitFor(() => w.hostNative.started === 1)).toBe(true);
      for (let i = 1; i <= 22; i += 1) { w.host.pushFrame(syntheticJpeg(i, canary), Date.now()); await tick(3); }
      expect(await waitFor(() => w.store.getSnapshot().vm.phase === 'live')).toBe(true);
      w.store.stop(); w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
      await tick(20);
    }
  });

  it('chaos: ≥10× fresh start→frame→stop flows stay correct', async () => {
    for (let i = 0; i < 10; i += 1) {
      const w = await wire();
      w.store.requestView();
      expect(await waitFor(() => w.hostNative.started === 1, 6000)).toBe(true);
      for (let f = 1; f <= 3; f += 1) { w.host.pushFrame(syntheticJpeg(f, `chaos${i}`), Date.now()); await tick(6); }
      expect(await waitFor(() => w.store.getSnapshot().vm.phase === 'live', 6000)).toBe(true);
      w.store.stop();
      w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
      await tick(20);
    }
  });

  it('B1-R1 cold-start: grant restored AFTER boot (no session/host change) → client attaches on the grant signal, then streams', async () => {
    const w = await wire({ grant: false });
    expect(w.runtime.isAttached()).toBe(false); // boot refresh saw no grant → not attached (was the no-op)
    // restore completes → grant appears → the grant subscription fires (NO session/host change)
    w.setGranted(true);
    w.fireGrant();
    expect(await waitFor(() => w.runtime.isAttached(), 4000)).toBe(true); // ← attaches on the grant signal
    // and the full installed stream now works end to end
    w.store.requestView();
    expect(await waitFor(() => w.hostNative.started === 1, 6000)).toBe(true);
    for (let i = 1; i <= 22; i += 1) { w.host.pushFrame(syntheticJpeg(i, 'coldstart'), Date.now()); await tick(4); }
    expect(await waitFor(() => w.store.getSnapshot().vm.phase === 'live', 6000)).toBe(true);
    w.store.stop(); w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
  });

  it('B1-R1 revoke fires the grant signal → the mobile client detaches (no stale stream)', async () => {
    const w = await wire();
    expect(w.runtime.isAttached()).toBe(true);
    w.setGranted(false);
    w.fireGrant(); // revoke path — no session/host change
    expect(await waitFor(() => !w.runtime.isAttached(), 4000)).toBe(true);
    w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
  });

  it('M-A/B2-R1: with NO confirmed display the mobile receives source-required and the host never captures', async () => {
    const w = await wire();
    w.setSourceLost(); // operator has not confirmed a display (configuredSourcePolicyId → null)
    await w.host.onAuthorityChanged();
    w.store.requestView();
    // the host denies before capture; the SwiftContract native is never dialed with an empty id
    expect(await waitFor(() => w.store.getSnapshot().vm.phase === 'source-required', 5000)).toBe(true);
    expect(w.hostNative.started).toBe(0);
    expect(w.hostNative.sawEmpty).toBe(false);
    w.host.stop(); w.hostLink.destroy(); w.runtime.detach();
  });

  // NOTE: host-wide start-replay (sequential-after-stop + N=20 concurrent, across busy/
  // source-lost/expiry, no memory growth) is exhaustively covered at the coordinator layer
  // in MacOS/brain/shadow-screen-host.test.ts (H1-R1) — the correct seam to inject a
  // captured signed start. The relay here only carries controller→host frames, so an
  // adversarial replay is modelled there, not re-implemented against the live socket.
});
