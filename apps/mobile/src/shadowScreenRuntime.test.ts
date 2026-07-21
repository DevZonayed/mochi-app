import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { nobleShadowCrypto } from './shadowCryptoNoble';
import { ScreenRuntime, type ScreenClientMaterial, type ScreenWsLike, type ScreenRuntimeDeps } from './shadowScreenRuntime';
import type { ScreenViewerClient } from './shadowScreenViewerStore';
import type { ScreenClientState } from './shadowScreenClient';

const backend = nobleShadowCrypto();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeWs implements ScreenWsLike {
  sent: string[] = [];
  binarySent = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  closed = false;
  send(data: string | ArrayBufferView | ArrayBuffer): void { if (typeof data === 'string') this.sent.push(data); else this.binarySent += 1; }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
}

class FakeStore {
  attached: ScreenViewerClient | null = null;
  authority: Array<{ screenViewGranted: boolean; online: boolean }> = [];
  states: ScreenClientState[] = [];
  attach(c: ScreenViewerClient): void { this.attached = c; }
  onClientState(s: ScreenClientState): void { this.states.push(s); }
  setAuthority(a: { screenViewGranted: boolean; online: boolean; hostName?: string }): void { this.authority.push({ screenViewGranted: a.screenViewGranted, online: a.online }); }
}

async function material(): Promise<ScreenClientMaterial> {
  const ctrlAgree = await backend.generateAgreementKeyPair();
  const hostAgree = await backend.generateAgreementKeyPair();
  const ctrlSign = await backend.generateSigningKeyPair();
  const hostSign = await backend.generateSigningKeyPair();
  return {
    controllerAgreementPrivate: ctrlAgree.privateKey, hostAgreementPublic: hostAgree.publicKey,
    controllerSigningPrivate: ctrlSign.privateKey, controllerSigningKeyId: 'sk_ctrl', hostSigningPublic: hostSign.publicKey,
    identity: { accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15 },
  };
}

function makeRuntime(over: Partial<ScreenRuntimeDeps> & { store: FakeStore; ws: () => FakeWs; granted: () => boolean; mat: () => Promise<ScreenClientMaterial | null> }) {
  let sessionCb: (() => void) | null = null;
  let grantCb: (() => void) | null = null;
  let sessionValue: ReturnType<ScreenRuntimeDeps['session']> = { relayOrigin: 'https://relay.example', sessionToken: 'tok', deviceId: 'ctrl_1', hostId: 'host_1' };
  const created: FakeWs[] = [];
  const deps: ScreenRuntimeDeps = {
    backend,
    store: over.store,
    getMaterial: over.mat,
    isScreenViewGranted: async () => over.granted(),
    session: () => sessionValue,
    isOnline: () => true,
    hostName: () => 'your Mac',
    createWs: () => { const w = over.ws(); created.push(w); return w; },
    subscribeSession: (cb) => { sessionCb = cb; return () => {}; },
    subscribeActiveHost: () => () => {},
    subscribeGrant: (cb) => { grantCb = cb; return () => { grantCb = null; }; },
    now: () => 1_000_000,
    newStreamId: () => 'stream_1',
  };
  const rt = new ScreenRuntime(deps);
  return { rt, created, fireSession: () => sessionCb?.(), fireGrant: () => grantCb?.(), setSession: (v: ReturnType<ScreenRuntimeDeps['session']>) => { sessionValue = v; } };
}

describe('ScreenRuntime (B1) — production owner attaches + drives a real client', () => {
  it('attaches a real ScreenStreamClient when screen.view is granted', async () => {
    const store = new FakeStore();
    const mat = await material();
    const { rt } = makeRuntime({ store, ws: () => new FakeWs(), granted: () => true, mat: async () => mat });
    rt.start();
    await tick();
    expect(store.attached).not.toBeNull(); // ← attach() called in the runtime (non-test product code)
    expect(rt.isAttached()).toBe(true);
    expect(store.authority.at(-1)).toEqual({ screenViewGranted: true, online: true });
  });

  it('tapping View (store client) dials /ws/remote/screen and sends a SIGNED screen-start', async () => {
    const store = new FakeStore();
    const mat = await material();
    let ws: FakeWs | null = null;
    const { rt } = makeRuntime({ store, ws: () => (ws = new FakeWs()), granted: () => true, mat: async () => mat });
    rt.start();
    await tick();
    // the store's attached client is the REAL ScreenStreamClient
    store.attached!.requestView();
    await tick();
    // link opened the WS lazily; flush the queued start on open
    expect(ws).not.toBeNull();
    ws!.open();
    await tick();
    expect(ws!.sent.length).toBeGreaterThanOrEqual(1);
    const start = JSON.parse(ws!.sent[0]!);
    expect(start.kind).toBe('screen-start');
    expect(start.signerRole).toBe('controller'); // H1: the start is signed
    expect(typeof start.signature).toBe('string');
    expect(start.accountId).toBe('acc_1');
  });

  it('detaches + goes idle when the grant loses screen.view (revoke/expiry)', async () => {
    const store = new FakeStore();
    const mat = await material();
    let granted = true;
    const { rt, fireSession } = makeRuntime({ store, ws: () => new FakeWs(), granted: () => granted, mat: async () => (granted ? mat : null) });
    rt.start();
    await tick();
    expect(rt.isAttached()).toBe(true);
    granted = false;
    fireSession();
    await tick();
    expect(rt.isAttached()).toBe(false);
    expect(store.authority.at(-1)).toEqual({ screenViewGranted: false, online: true });
  });

  it('shows idle-unavailable (no attach) when there is no enrolled material', async () => {
    const store = new FakeStore();
    const { rt } = makeRuntime({ store, ws: () => new FakeWs(), granted: () => true, mat: async () => null });
    rt.start();
    await tick();
    expect(rt.isAttached()).toBe(false);
    expect(store.authority.at(-1)?.screenViewGranted).toBe(true); // granted flag surfaced…
    // …but no client attached ⇒ the store keeps a truthful idle/unavailable state.
  });
});

describe('ScreenRuntime (B1-R1) — attaches on GRANT change, not just session/host', () => {
  it('cold-start: grant restored after an async delay → the client attaches on the grant signal', async () => {
    // Boot BEFORE the grant is available (restore still in flight) — the exact primary
    // flow the reviewer flagged. Nothing attaches on the boot refresh…
    const store = new FakeStore();
    const mat = await material();
    let restored = false;
    const { rt, fireGrant } = makeRuntime({ store, ws: () => new FakeWs(), granted: () => restored, mat: async () => (restored ? mat : null) });
    rt.start();
    await tick();
    expect(rt.isAttached()).toBe(false); // no grant yet → no attach (was the silent no-op)
    // …then restore completes and fires the grant subscription:
    restored = true;
    fireGrant();
    await tick();
    expect(rt.isAttached()).toBe(true); // ← now attached because of the GRANT signal
  });

  it('fresh enrollment accepted (no session/host change) → attaches on the grant signal', async () => {
    const store = new FakeStore();
    const mat = await material();
    let accepted = false;
    const { rt, fireGrant } = makeRuntime({ store, ws: () => new FakeWs(), granted: () => accepted, mat: async () => (accepted ? mat : null) });
    rt.start();
    await tick();
    expect(rt.isAttached()).toBe(false);
    accepted = true; // poll() set the grant; NO session/host event fired
    fireGrant();
    await tick();
    expect(rt.isAttached()).toBe(true);
  });

  it('revoke / capability loss fires the grant signal → detaches + zeroes', async () => {
    const store = new FakeStore();
    const mat = await material();
    let granted = true;
    const { rt, fireGrant } = makeRuntime({ store, ws: () => new FakeWs(), granted: () => granted, mat: async () => (granted ? mat : null) });
    rt.start();
    await tick();
    expect(rt.isAttached()).toBe(true);
    granted = false;
    fireGrant(); // revoke → grant subscription fires (no session/host change)
    await tick();
    expect(rt.isAttached()).toBe(false);
  });

  it('a grant change landing DURING an in-flight refresh is not dropped (coalesced re-run)', async () => {
    const store = new FakeStore();
    const mat = await material();
    let granted = false;
    let resolveMat: (() => void) | null = null;
    const gate = new Promise<void>((r) => { resolveMat = r; });
    // First refresh: material resolution is gated so we can fire a grant change mid-flight.
    const { rt, fireGrant } = makeRuntime({
      store, ws: () => new FakeWs(), granted: () => granted,
      mat: async () => { if (!granted) return null; await gate; return mat; },
    });
    rt.start();
    await tick();
    expect(rt.isAttached()).toBe(false);
    granted = true;
    fireGrant();        // starts refresh #2 (awaits the gate)
    await tick();
    fireGrant();        // lands mid-refresh → must be remembered, not dropped
    resolveMat!();
    await tick(); await tick();
    expect(rt.isAttached()).toBe(true); // coalesced re-run attached with the current grant
  });

  it('tapping View sends EXACTLY ONE signed start', async () => {
    const store = new FakeStore();
    const mat = await material();
    let ws: FakeWs | null = null;
    const { rt } = makeRuntime({ store, ws: () => (ws = new FakeWs()), granted: () => true, mat: async () => mat });
    rt.start();
    await tick();
    store.attached!.requestView();
    await tick();
    ws!.open();
    await tick();
    const starts = ws!.sent.map((s) => JSON.parse(s)).filter((m) => m.kind === 'screen-start');
    expect(starts.length).toBe(1); // exactly one signed start
    expect(starts[0].signerRole).toBe('controller');
  });

  it('survives 20× randomized boot orderings (grant vs session vs host) → deterministic attach', async () => {
    for (let i = 0; i < 20; i++) {
      const store = new FakeStore();
      const mat = await material();
      let granted = false;
      const { rt, fireGrant, fireSession } = makeRuntime({ store, ws: () => new FakeWs(), granted: () => granted, mat: async () => (granted ? mat : null) });
      rt.start();
      // Deterministic-but-varied interleaving per iteration (no Math.random in workflow-safe code).
      const order = [() => fireSession(), () => { granted = true; fireGrant(); }, () => fireGrant()];
      const rot = i % order.length;
      for (let k = 0; k < order.length; k++) { order[(k + rot) % order.length]!(); await tick(); }
      await tick();
      expect(rt.isAttached()).toBe(true); // whatever the order, the grant signal converges to attached
      rt.dispose();
      expect(rt.isAttached()).toBe(false); // cancellable cleanup detaches + zeroes
    }
  });
});

describe('ScreenRuntime (B1) — App startup owns the runtime (source contract)', () => {
  const APP = readFileSync(new URL('../App.tsx', import.meta.url).pathname, 'utf8');
  it('App.tsx imports + calls the production screen runtime owner in boot', () => {
    expect(APP).toContain("from './src/shadowScreenRuntimeProd'");
    expect(APP).toContain('getShadowScreenRuntime()');
  });
  it('the runtime attaches a client (attach) and the store is not a no-op', () => {
    const RT = readFileSync(new URL('./shadowScreenRuntime.ts', import.meta.url).pathname, 'utf8');
    expect(RT).toContain('this.deps.store.attach(client)');
    expect(RT).toContain('new ScreenStreamClient(');
    expect(RT).toContain('/ws/remote/screen');
    // raw private key bytes must NOT be logged / stored
    expect(RT).not.toMatch(/console\.(log|warn|error)\([^)]*(Private|signing|agreement)/i);
  });
});
