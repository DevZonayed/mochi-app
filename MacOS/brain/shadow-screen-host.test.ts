import { describe, expect, it } from 'vitest';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import {
  ScreenFrameReceiver,
  decodeStreamNonce,
  deriveScreenStreamKey,
  freshStreamNonce,
  signScreenControl,
  type ScreenAuthoritySnapshot,
  type ScreenControlBinding,
  type ScreenControlMessage,
  type ScreenSourcePolicy,
  type ScreenStreamBinding,
} from '@maestro/realtime/shadowScreenStream';
import {
  ScreenStreamHostCoordinator,
  type CaptureStartOptions,
  type ScreenAuditEntry,
  type ScreenCaptureAdapter,
  type ScreenRelayLink,
} from './shadow-screen-host.js';

const backend = nodeShadowCrypto;
const FENCE = { accountId: 'acc_1', scopeId: 'scope_1', hostDeviceId: 'host_1', epoch: 3, leaseId: 'lease_1' };
const SOURCE: ScreenSourcePolicy = { sourcePolicyId: 'src_main', kind: 'display', label: 'Built-in Display · 1512×982', width: 1512, height: 982 };

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fakeFrame(seq: number, size = 4096): Uint8Array {
  const b = new Uint8Array(size); b[0] = 0xff; b[1] = 0xd8;
  for (let i = 2; i < size - 2; i += 1) b[i] = (seq * 17 + i) & 0xff;
  b[size - 2] = 0xff; b[size - 1] = 0xd9; return b;
}

class FakeLink implements ScreenRelayLink {
  controls: ScreenControlMessage[] = [];
  frames: Uint8Array[] = [];
  private controlCb: ((raw: unknown) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  sendControl(msg: ScreenControlMessage): void { this.controls.push(msg); }
  sendFrame(env: Uint8Array): void { this.frames.push(env); }
  onControl(cb: (raw: unknown) => void): void { this.controlCb = cb; }
  onDisconnect(cb: () => void): void { this.disconnectCb = cb; }
  deliver(msg: unknown): void { this.controlCb?.(msg); }
  disconnect(): void { this.disconnectCb?.(); }
  lastStatus(): ScreenControlMessage | undefined { return [...this.controls].reverse().find((c) => c.kind === 'screen-status'); }
  accept(): (ScreenControlMessage & { kind: 'screen-accept' }) | undefined {
    return this.controls.find((c) => c.kind === 'screen-accept') as never;
  }
}

class FakeCapture implements ScreenCaptureAdapter {
  emit: ((bytes: Uint8Array, ts: number) => void) | null = null;
  onError: ((reason: string) => void) | null = null;
  started = 0;
  stopped = 0;
  constructor(private permission: 'granted' | 'denied' | 'undetermined' = 'granted', private available = true, private dims = { width: 1280, height: 720 }) {}
  async preflightPermission() { return this.permission; }
  async isSourceAvailable() { return this.available; }
  async start(opts: CaptureStartOptions) {
    this.started += 1;
    this.emit = opts.onFrame; this.onError = opts.onError;
    return { ok: true as const, width: this.dims.width, height: this.dims.height };
  }
  async stop() { this.stopped += 1; this.emit = null; }
}

function ctlBinding(over: Partial<ScreenControlBinding> = {}): ScreenControlBinding {
  return { accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15, streamId: 'stream_1', ...over };
}

async function fullSetup(opts: { authority?: Partial<ScreenAuthoritySnapshot>; capture?: FakeCapture } = {}) {
  const hostAgree = await backend.generateAgreementKeyPair();
  const ctrlAgree = await backend.generateAgreementKeyPair();
  const hostSign = await backend.generateSigningKeyPair();
  const ctrlSign = await backend.generateSigningKeyPair();
  const capture = opts.capture ?? new FakeCapture();
  const link = new FakeLink();
  const audits: ScreenAuditEntry[] = [];
  const shareStatuses: Array<{ active: boolean } | null> = [];
  const authority: ScreenAuthoritySnapshot = {
    fence: FENCE, leaseExpiresAtMs: 10 ** 15, grantedCapabilities: ['account.read', 'screen.view'],
    revokedControllerDeviceIds: [], hostOnline: true, configuredSourcePolicyId: 'src_main', foreground: true,
    ...opts.authority,
  };
  let authRef = authority;
  const snapshotCalls: string[] = [];
  let authFn: (id: string) => ScreenAuthoritySnapshot | null = () => authRef;
  const agreePubs = new Map<string, Uint8Array>([['ctrl_1', ctrlAgree.publicKey]]);
  const signPubs = new Map<string, Uint8Array>([['ctrl_1', ctrlSign.publicKey]]);
  const coord = new ScreenStreamHostCoordinator({
    backend,
    hostAgreementPrivate: hostAgree.privateKey,
    hostSigningPrivate: hostSign.privateKey,
    hostSigningKeyId: 'sk_host',
    resolveControllerAgreementPublic: (id) => agreePubs.get(id) ?? null,
    resolveControllerSigningPublic: (id) => signPubs.get(id) ?? null,
    authoritySnapshot: (id) => { snapshotCalls.push(id); return authFn(id); },
    sourcePolicy: () => SOURCE,
    capture,
    link,
    now: () => 1_000_000,
    randomNonce: () => freshStreamNonce(backend),
    audit: (e) => audits.push(e),
    onShareStatus: (s) => shareStatuses.push(s),
  });
  coord.start();
  // Sign a start with an ENROLLED controller key (H1) so the coordinator accepts it.
  const signStart = async (over: Partial<Record<string, unknown>> = {}) => {
    const base = rawStart(over);
    const did = base.controllerDeviceId as string;
    const priv = did === 'ctrl_1' ? ctrlSign.privateKey : (extraSigners.get(did) as Uint8Array);
    return signScreenControl(backend, priv, {
      role: 'controller', signerKeyId: `sk_${did}`, controlNonce: freshStreamNonce(backend).b64, message: base as never,
      binding: ctlBinding({ streamId: base.streamId as string, controllerDeviceId: did }),
    });
  };
  const extraSigners = new Map<string, Uint8Array>();
  const enroll = async (deviceId: string) => {
    const a = await backend.generateAgreementKeyPair();
    const s = await backend.generateSigningKeyPair();
    agreePubs.set(deviceId, a.publicKey); signPubs.set(deviceId, s.publicKey); extraSigners.set(deviceId, s.privateKey);
  };
  return { coord, capture, link, audits, shareStatuses, hostAgree, ctrlAgree, hostSign, ctrlSign, signStart, enroll, snapshotCalls, setAuthority: (a: ScreenAuthoritySnapshot) => { authRef = a; }, setAuthorityFn: (fn: (id: string) => ScreenAuthoritySnapshot | null) => { authFn = fn; } };
}

function rawStart(over: Partial<Record<string, unknown>> = {}) {
  return {
    kind: 'screen-start', v: 1, streamId: 'stream_1', accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1',
    grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', sourcePolicyId: 'src_main',
    requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: 8,
    controllerNonce: freshStreamNonce(backend).b64, requestedAt: 1_000_000, expiresAt: 1_000_000 + 60_000, ...over,
  };
}

describe('ScreenStreamHostCoordinator — happy path', () => {
  it('accepts a valid start, streams frames the controller can decrypt, then stops', async () => {
    const { capture, link, audits, shareStatuses, hostAgree, ctrlAgree, ctrlSign, signStart } = await fullSetup();
    const req = await signStart();
    link.deliver(req);
    await tick();

    const accept = link.accept();
    expect(accept).toBeTruthy();
    expect(accept!.sourceLabel).toBe(SOURCE.label);
    expect(accept!.width).toBe(1280);
    expect((accept as { signature?: string }).signature).toBeTruthy(); // accept is host-SIGNED
    expect((accept as { signerRole?: string }).signerRole).toBe('host');

    // Build the controller's receiver from the accept.
    const binding: ScreenStreamBinding = {
      streamId: 'stream_1', accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1',
      grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15, sourcePolicyId: 'src_main', codec: 'jpeg', width: accept!.width, height: accept!.height,
    };
    const ctrlKey = await deriveScreenStreamKey({
      backend, selfAgreementPrivate: ctrlAgree.privateKey, peerAgreementPublic: hostAgree.publicKey,
      hostNonce: decodeStreamNonce(accept!.hostNonce), controllerNonce: decodeStreamNonce((req as { controllerNonce: string }).controllerNonce), binding, keyEpoch: accept!.keyEpoch,
    });
    const receiver = new ScreenFrameReceiver(backend, ctrlKey, binding, accept!.keyEpoch, { expiresAtMs: accept!.expiresAt });

    // Host emits frames via capture; they arrive sealed on the link.
    capture.emit!(fakeFrame(1), 1_000_001);
    capture.emit!(fakeFrame(2), 1_000_002);
    await tick();
    expect(link.frames.length).toBe(2);
    const r1 = await receiver.accept(link.frames[0]!, 1_000_003);
    expect(r1.ok).toBe(true);
    const r2 = await receiver.accept(link.frames[1]!, 1_000_004);
    expect(r2.ok).toBe(true);
    if (r1.ok) expect(Buffer.from(r1.frameBytes).equals(Buffer.from(fakeFrame(1)))).toBe(true);

    // First frame flips status to live.
    expect(link.controls.some((c) => c.kind === 'screen-status' && c.status === 'live')).toBe(true);
    expect(audits.find((a) => a.event === 'stream-started')).toBeTruthy();

    // Controller stops — must be SIGNED by the enrolled controller (H1).
    const stop = await signScreenControl(backend, ctrlSign.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: { kind: 'screen-stop', v: 1, streamId: 'stream_1', reason: 'done', at: 1_000_010 }, binding: ctlBinding() });
    link.deliver(stop);
    await tick();
    expect(capture.stopped).toBe(1);
    expect(link.lastStatus()!).toMatchObject({ status: 'stopped' });
    const stopAudit = audits.find((a) => a.event === 'stream-stopped');
    expect(stopAudit).toBeTruthy();
    // audit is metadata-only — no frame bytes / titles / keys
    expect(JSON.stringify(stopAudit)).not.toContain('src_main'); // uses sourcePolicyClass, not the id
    expect(stopAudit!.framesSent).toBe(2);
    // host-visible share status: active on start, cleared on stop
    expect(shareStatuses[0]).toMatchObject({ active: true });
    expect(shareStatuses[shareStatuses.length - 1]).toBeNull();
    // status carries no frame/key material
    expect(JSON.stringify(shareStatuses)).not.toMatch(/frame|nonce|cipher|base64/i);
  });
});

describe('ScreenStreamHostCoordinator — consent + lifecycle denials', () => {
  it('denies without screen.view capability (never starts capture)', async () => {
    const { capture, link, audits, signStart } = await fullSetup({ authority: { grantedCapabilities: ['account.read'] } });
    link.deliver(await signStart());
    await tick();
    expect(link.accept()).toBeFalsy();
    expect(link.lastStatus()!).toMatchObject({ status: 'permission-denied' });
    expect(capture.stopped).toBe(0);
    expect(audits.find((a) => a.event === 'stream-denied')).toBeTruthy();
  });

  it('rejects an UNSIGNED start (structurally valid) — never starts capture (H1/R4)', async () => {
    const { capture, link, audits } = await fullSetup();
    link.deliver(rawStart()); // no signature envelope
    await tick();
    expect(link.accept()).toBeFalsy();
    expect(capture.started).toBe(0);
    expect(link.lastStatus()!).toMatchObject({ status: 'error' });
    expect(audits.find((a) => a.event === 'stream-denied' && a.reason === 'unsigned-or-forged')).toBeTruthy();
  });

  it('rejects a FORGED start (signed by a non-enrolled key) — never starts capture', async () => {
    const { capture, link } = await fullSetup();
    const attacker = await backend.generateSigningKeyPair();
    const forged = await signScreenControl(backend, attacker.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl_1', controlNonce: freshStreamNonce(backend).b64, message: rawStart() as never, binding: ctlBinding() });
    link.deliver(forged);
    await tick();
    expect(capture.started).toBe(0);
    expect(link.accept()).toBeFalsy();
  });

  it('permission-required when the OS permission is undetermined', async () => {
    const cap = new FakeCapture('undetermined');
    const { link, signStart } = await fullSetup({ capture: cap });
    link.deliver(await signStart());
    await tick();
    expect(link.lastStatus()!).toMatchObject({ status: 'permission-required' });
  });

  it('busy: a second (enrolled) device never steals the active viewer', async () => {
    const { link, signStart, enroll } = await fullSetup();
    link.deliver(await signStart());
    await tick();
    await enroll('ctrl_2');
    link.deliver(await signStart({ controllerDeviceId: 'ctrl_2', streamId: 'stream_2' }));
    await tick();
    const busy = link.controls.find((c) => c.kind === 'screen-status' && c.status === 'busy');
    expect(busy).toBeTruthy();
  });

  it('stops on link disconnect and on host stop and on authority revoke', async () => {
    const a = await fullSetup();
    a.link.deliver(await a.signStart());
    await tick();
    a.capture.emit!(fakeFrame(1), 1_000_001);
    await tick();
    a.link.disconnect();
    await tick();
    expect(a.capture.stopped).toBe(1);

    // fresh coordinator: host-initiated stop
    const b = await fullSetup();
    b.link.deliver(await b.signStart());
    await tick();
    await b.coord.stopByHost();
    expect(b.capture.stopped).toBe(1);

    // fresh coordinator: authority revoke mid-stream
    const c = await fullSetup();
    c.link.deliver(await c.signStart());
    await tick();
    c.setAuthority({ fence: FENCE, leaseExpiresAtMs: 10 ** 15, grantedCapabilities: ['account.read', 'screen.view'], revokedControllerDeviceIds: ['ctrl_1'], hostOnline: true, configuredSourcePolicyId: 'src_main', foreground: true });
    await c.coord.onAuthorityChanged();
    expect(c.capture.stopped).toBe(1);
    expect(c.link.lastStatus()!).toMatchObject({ status: 'stopped' });
  });

  it('ignores malformed control messages (fail closed, no capture)', async () => {
    const { link, capture } = await fullSetup();
    link.deliver({ kind: 'screen-input', v: 1, streamId: 'x' });
    link.deliver({ nonsense: true });
    link.deliver(null);
    await tick();
    expect(link.accept()).toBeFalsy();
    expect(capture.stopped).toBe(0);
  });
});

describe('ScreenStreamHostCoordinator — H1-R1 host-wide start-replay guard', () => {
  it('a captured signed start replayed AFTER stop is rejected (replay) — no second capture', async () => {
    const { coord, capture, link, audits, ctrlSign, signStart } = await fullSetup();
    const req = await signStart(); // one signed start we will replay verbatim
    link.deliver(req);
    await tick();
    expect(capture.started).toBe(1);
    // controller stops the stream (signed) — the guard MUST survive the stop
    const stop = await signScreenControl(backend, ctrlSign.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: { kind: 'screen-stop', v: 1, streamId: 'stream_1', reason: 'done', at: 1_000_010 }, binding: ctlBinding() });
    link.deliver(stop);
    await tick();
    expect(capture.stopped).toBe(1);
    // replay the SAME signed start within the skew window → rejected, no re-capture
    link.deliver(req);
    await tick();
    expect(capture.started).toBe(1); // NOT 2
    expect(audits.filter((a) => a.event === 'stream-denied' && a.reason === 'replay').length).toBe(1);
    expect(coord.startReplayCacheSize()).toBeGreaterThanOrEqual(1);
  });

  it('N=20 concurrent duplicate starts → exactly ONE captures, the rest reject before capture', async () => {
    const { capture, link, audits, signStart } = await fullSetup();
    const req = await signStart();
    for (let i = 0; i < 20; i++) link.deliver(req); // fire all before any awaits settle
    await tick(); await tick(); await tick();
    expect(capture.started).toBe(1); // exactly one winner
    expect(audits.filter((a) => a.event === 'stream-denied' && a.reason === 'replay').length).toBe(19);
  });

  it('a genuine re-start with a FRESH nonce is allowed (not a replay)', async () => {
    const { capture, link, signStart } = await fullSetup();
    link.deliver(await signStart());       // nonce A
    await tick();
    link.deliver(await signStart({ streamId: 'stream_1b' })); // nonce B (fresh sign) → same device restart
    await tick();
    expect(capture.started).toBe(2); // both allowed; the guard only blocks identical nonces
  });

  it('destroy() clears the guard (only place it clears)', async () => {
    const { coord, link, signStart } = await fullSetup();
    link.deliver(await signStart());
    await tick();
    expect(coord.startReplayCacheSize()).toBeGreaterThanOrEqual(1);
    await coord.destroy();
    expect(coord.startReplayCacheSize()).toBe(0);
  });
});

describe('ScreenStreamHostCoordinator — H1-R2 controller-scoped capability authority', () => {
  it('gate reads the REQUESTING controller\'s grant: A(screen.view) accepts, B(account.read) denied', async () => {
    const s = await fullSetup();
    await s.enroll('ctrl_A'); await s.enroll('ctrl_B');
    // Per-controller scoped authority — B lacks screen.view. snapshot('') must NEVER be used.
    s.setAuthorityFn((id) => {
      if (id === '') throw new Error('unscoped snapshot("") must never be used');
      const caps = id === 'ctrl_B' ? (['account.read'] as const) : (['account.read', 'screen.view'] as const);
      return { fence: FENCE, leaseExpiresAtMs: 10 ** 15, grantedCapabilities: [...caps], revokedControllerDeviceIds: [], hostOnline: true, configuredSourcePolicyId: 'src_main', foreground: true };
    });
    // B (account.read only) → denied, no capture
    s.link.deliver(await s.signStart({ controllerDeviceId: 'ctrl_B', streamId: 'stream_B' }));
    await tick();
    expect(s.link.controls.find((c) => c.kind === 'screen-status' && c.status === 'permission-denied')).toBeTruthy();
    expect(s.capture.started).toBe(0);
    // A (screen.view) → accepted
    s.link.deliver(await s.signStart({ controllerDeviceId: 'ctrl_A', streamId: 'stream_A' }));
    await tick();
    expect(s.capture.started).toBe(1);
    expect(s.link.accept()).toBeTruthy();
    // the coordinator scoped every snapshot to the exact requester (never '')
    expect(s.snapshotCalls).toContain('ctrl_B');
    expect(s.snapshotCalls).toContain('ctrl_A');
    expect(s.snapshotCalls).not.toContain('');
  });

  it('an enrolled device with NO grant (null snapshot) fails closed before capture', async () => {
    const s = await fullSetup();
    await s.enroll('ctrl_X');
    s.setAuthorityFn((id) => (id === 'ctrl_X' ? null : null));
    s.link.deliver(await s.signStart({ controllerDeviceId: 'ctrl_X', streamId: 'stream_X' }));
    await tick();
    expect(s.capture.started).toBe(0);
    expect(s.audits.find((a) => a.event === 'stream-denied' && a.reason === 'no-grant')).toBeTruthy();
  });
});

describe('ScreenStreamHostCoordinator — M-A operator un-confirms the display', () => {
  it('clearing the configured source mid-stream stops the live stream', async () => {
    const s = await fullSetup();
    s.link.deliver(await s.signStart());
    await tick();
    s.capture.emit!(fakeFrame(1), 1_000_001);
    await tick();
    expect(s.capture.stopped).toBe(0);
    // operator un-confirms the display → configuredSourcePolicyId becomes null
    s.setAuthority({ fence: FENCE, leaseExpiresAtMs: 10 ** 15, grantedCapabilities: ['account.read', 'screen.view'], revokedControllerDeviceIds: [], hostOnline: true, configuredSourcePolicyId: null, foreground: true });
    await s.coord.onAuthorityChanged();
    expect(s.capture.stopped).toBe(1);
  });

  it('switching to a DIFFERENT display mid-stream stops the current stream', async () => {
    const s = await fullSetup();
    s.link.deliver(await s.signStart());
    await tick();
    s.setAuthority({ fence: FENCE, leaseExpiresAtMs: 10 ** 15, grantedCapabilities: ['account.read', 'screen.view'], revokedControllerDeviceIds: [], hostOnline: true, configuredSourcePolicyId: 'display:99', foreground: true });
    await s.coord.onAuthorityChanged();
    expect(s.capture.stopped).toBe(1);
  });
});
