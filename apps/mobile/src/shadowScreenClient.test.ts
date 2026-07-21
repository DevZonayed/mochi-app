import { describe, expect, it } from 'vitest';
import { nobleShadowCrypto } from './shadowCryptoNoble';
import {
  ScreenFrameSender,
  decodeStreamNonce,
  deriveScreenStreamKey,
  freshStreamNonce,
  signScreenControl,
  type ScreenControlBinding,
  type ScreenControlMessage,
  type ScreenStreamBinding,
} from '@maestro/realtime/shadowScreenStream';
import {
  ScreenStreamClient,
  type ScreenClientDeps,
  type ScreenClientIdentity,
  type ScreenClientLink,
  type ScreenClientState,
} from './shadowScreenClient';

const backend = nobleShadowCrypto();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const IDENTITY: ScreenClientIdentity = {
  accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1',
  scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15, sourcePolicyId: 'src_main',
  requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: 8,
};

function ctlBinding(streamId: string): ScreenControlBinding {
  return {
    accountId: IDENTITY.accountId, hostDeviceId: IDENTITY.hostDeviceId, controllerDeviceId: IDENTITY.controllerDeviceId,
    grantId: IDENTITY.grantId, scopeId: IDENTITY.scopeId, epoch: IDENTITY.epoch, leaseId: IDENTITY.leaseId,
    leaseExpiresAt: IDENTITY.leaseExpiresAt, streamId,
  };
}

function fakeFrame(seq: number, size = 4096): Uint8Array {
  const b = new Uint8Array(size); b[0] = 0xff; b[1] = 0xd8;
  for (let i = 2; i < size - 2; i += 1) b[i] = (seq * 23 + i) & 0xff;
  b[size - 2] = 0xff; b[size - 1] = 0xd9; return b;
}

class FakeLink implements ScreenClientLink {
  sentControls: ScreenControlMessage[] = [];
  private controlCb: ((raw: unknown) => void) | null = null;
  private frameCb: ((env: Uint8Array) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  sendControl(msg: ScreenControlMessage): void { this.sentControls.push(msg); }
  onControl(cb: (raw: unknown) => void): void { this.controlCb = cb; }
  onFrame(cb: (env: Uint8Array) => void): void { this.frameCb = cb; }
  onDisconnect(cb: () => void): void { this.disconnectCb = cb; }
  toClientControl(msg: unknown): void { this.controlCb?.(msg); }
  toClientFrame(env: Uint8Array): void { this.frameCb?.(env); }
  disconnect(): void { this.disconnectCb?.(); }
  lastStart() { return [...this.sentControls].reverse().find((c) => c.kind === 'screen-start') as (ScreenControlMessage & { kind: 'screen-start' }) | undefined; }
}

async function setup() {
  const hostAgree = await backend.generateAgreementKeyPair();
  const ctrlAgree = await backend.generateAgreementKeyPair();
  const hostSign = await backend.generateSigningKeyPair();
  const ctrlSign = await backend.generateSigningKeyPair();
  const link = new FakeLink();
  const states: ScreenClientState[] = [];
  let clock = 1_000_000;
  const client = new ScreenStreamClient({
    backend, controllerAgreementPrivate: ctrlAgree.privateKey, hostAgreementPublic: hostAgree.publicKey,
    controllerSigningPrivate: ctrlSign.privateKey, controllerSigningKeyId: 'sk_ctrl', hostSigningPublic: hostSign.publicKey,
    identity: IDENTITY, link, now: () => clock, newStreamId: () => 'stream_1', onState: (s) => states.push(s),
  } satisfies ScreenClientDeps);
  return { client, link, states, hostAgree, ctrlAgree, hostSign, ctrlSign, setClock: (n: number) => { clock = n; }, now: () => clock };
}

/** A host stub: derive the stream key + a SIGNED accept from the client's start. */
async function hostAccept(link: FakeLink, hostAgree: { privateKey: Uint8Array; publicKey: Uint8Array }, ctrlAgreePublic: Uint8Array, hostSignPriv: Uint8Array, now: number) {
  const start = link.lastStart()!;
  const hostNonce = freshStreamNonce(backend);
  const binding: ScreenStreamBinding = {
    streamId: start.streamId, accountId: start.accountId, hostDeviceId: start.hostDeviceId, controllerDeviceId: start.controllerDeviceId,
    grantId: start.grantId, scopeId: start.scopeId, epoch: start.epoch, leaseId: start.leaseId, leaseExpiresAt: IDENTITY.leaseExpiresAt, sourcePolicyId: start.sourcePolicyId, codec: 'jpeg', width: 1280, height: 720,
  };
  const keyEpoch = 1;
  const key = await deriveScreenStreamKey({
    backend, selfAgreementPrivate: hostAgree.privateKey, peerAgreementPublic: ctrlAgreePublic,
    hostNonce: hostNonce.bytes, controllerNonce: decodeStreamNonce(start.controllerNonce), binding, keyEpoch,
  });
  const sender = new ScreenFrameSender(backend, key, binding, keyEpoch);
  const acceptBase: ScreenControlMessage = {
    kind: 'screen-accept', v: 1, streamId: start.streamId, hostNonce: hostNonce.b64, codec: 'jpeg', width: 1280, height: 720,
    fps: 8, keyEpoch, sourcePolicyId: 'src_main', sourceLabel: 'Built-in Display · 1512×982', acceptedAt: now, expiresAt: now + 60_000,
  };
  const accept = await signScreenControl(backend, hostSignPriv, { role: 'host', signerKeyId: 'sk_host', controlNonce: freshStreamNonce(backend).b64, message: acceptBase, binding: ctlBinding(start.streamId) });
  return { accept, sender };
}

async function hostStatus(hostSignPriv: Uint8Array, streamId: string, status: string, now: number) {
  const base: ScreenControlMessage = { kind: 'screen-status', v: 1, streamId, status: status as never, at: now };
  return signScreenControl(backend, hostSignPriv, { role: 'host', signerKeyId: 'sk_host', controlNonce: freshStreamNonce(backend).b64, message: base, binding: ctlBinding(streamId) });
}

describe('ScreenStreamClient — happy path (signed control plane, H1)', () => {
  it('requests (signed) → verified accept → live only after the first authenticated frame', async () => {
    const { client, link, hostAgree, ctrlAgree, hostSign, now } = await setup();
    client.requestView();
    await tick(); // requestView signs asynchronously
    expect(client.getState().phase).toBe('requesting');
    const start = link.lastStart();
    expect(start).toBeTruthy();
    expect((start as { signature?: string }).signature).toBeTruthy(); // the start is SIGNED
    expect((start as { signerRole?: string }).signerRole).toBe('controller');

    const { accept, sender } = await hostAccept(link, hostAgree, ctrlAgree.publicKey, hostSign.privateKey, now());
    link.toClientControl(accept);
    await tick();
    expect(client.getState().phase).toBe('requesting'); // not live until first frame
    expect(client.getState().sourceLabel).toBe('Built-in Display · 1512×982');

    link.toClientFrame(await sender.seal(fakeFrame(1), now() + 1));
    await tick();
    expect(client.getState().phase).toBe('live');
    expect(client.getState().latestFrame!.seq).toBe(1);
    expect(Buffer.from(client.getState().latestFrame!.bytes).equals(Buffer.from(fakeFrame(1)))).toBe(true);

    const prevRef = client.getState().latestFrame!.bytes;
    link.toClientFrame(await sender.seal(fakeFrame(2), now() + 2));
    await tick();
    expect(client.getState().latestFrame!.seq).toBe(2);
    expect(prevRef.every((b) => b === 0)).toBe(true);
    expect(client.getState().framesDecoded).toBe(2);
  });

  it('a FORGED accept (signed by a stranger host key) is ignored — never goes live', async () => {
    const { client, link, hostAgree, ctrlAgree, now } = await setup();
    client.requestView();
    await tick();
    const stranger = await backend.generateSigningKeyPair();
    const { accept, sender } = await hostAccept(link, hostAgree, ctrlAgree.publicKey, stranger.privateKey, now());
    link.toClientControl(accept);
    await tick();
    // accept was signed by the WRONG host key → client never set up the receiver
    link.toClientFrame(await sender.seal(fakeFrame(1), now() + 1));
    await tick();
    expect(client.getState().phase).toBe('requesting');
    expect(client.getState().latestFrame).toBeNull();
  });

  it('local stop sends a SIGNED screen-stop and clears frame + key', async () => {
    const { client, link, hostAgree, ctrlAgree, hostSign, now } = await setup();
    client.requestView();
    await tick();
    const { accept, sender } = await hostAccept(link, hostAgree, ctrlAgree.publicKey, hostSign.privateKey, now());
    link.toClientControl(accept);
    await tick();
    link.toClientFrame(await sender.seal(fakeFrame(1), now() + 1));
    await tick();
    expect(client.getState().phase).toBe('live');
    client.stop('viewer left');
    await tick();
    const stop = link.sentControls.find((c) => c.kind === 'screen-stop') as { signerRole?: string; signature?: string } | undefined;
    expect(stop?.signature).toBeTruthy();
    expect(stop?.signerRole).toBe('controller');
    expect(client.getState().phase).toBe('stopped');
    expect(client.getState().latestFrame).toBeNull();
  });
});

describe('ScreenStreamClient — truthful state transitions (verified host status)', () => {
  it('maps SIGNED host status messages to phases; ignores unsigned/forged status', async () => {
    for (const [status, phase] of [
      ['permission-required', 'permission-required'], ['permission-denied', 'permission-denied'], ['busy', 'busy'],
      ['source-lost', 'source-lost'], ['revoked', 'revoked'], ['expired', 'expired'], ['error', 'error'],
    ] as const) {
      const { client, link, hostSign } = await setup();
      client.requestView();
      await tick();
      const signed = await hostStatus(hostSign.privateKey, 'stream_1', status, 1_000_001);
      link.toClientControl(signed);
      await tick();
      expect(client.getState().phase).toBe(phase);
    }
  });

  it('ignores an UNSIGNED status (structural only) — no state change', async () => {
    const { client, link } = await setup();
    client.requestView();
    await tick();
    link.toClientControl({ kind: 'screen-status', v: 1, streamId: 'stream_1', status: 'error', at: 1_000_001 });
    await tick();
    expect(client.getState().phase).toBe('requesting'); // unsigned → ignored
  });

  it('offline on link disconnect and on relay teardown (unsigned, stop-only)', async () => {
    const { client, link } = await setup();
    client.requestView(); await tick();
    link.disconnect();
    await tick();
    expect(client.getState().phase).toBe('offline');
    // relay teardown status (unsigned, reserved streamId) → offline
    const { client: c2, link: l2 } = await setup();
    c2.requestView(); await tick();
    l2.toClientControl({ kind: 'screen-status', v: 1, streamId: 'relay', status: 'stopped', at: 1 });
    await tick();
    expect(c2.getState().phase).toBe('offline');
  });
});

describe('ScreenStreamClient — adversarial frames are dropped, never surfaced', () => {
  it('drops a tampered frame (stays on the last good frame)', async () => {
    const { client, link, hostAgree, ctrlAgree, hostSign, now } = await setup();
    client.requestView(); await tick();
    const { accept, sender } = await hostAccept(link, hostAgree, ctrlAgree.publicKey, hostSign.privateKey, now());
    link.toClientControl(accept); await tick();
    link.toClientFrame(await sender.seal(fakeFrame(1), now() + 1)); await tick();
    expect(client.getState().latestFrame!.seq).toBe(1);
    const bad = await sender.seal(fakeFrame(2), now() + 2);
    bad[bad.length - 3] ^= 0x55;
    link.toClientFrame(bad); await tick();
    expect(client.getState().latestFrame!.seq).toBe(1);
    expect(client.getState().framesDecoded).toBe(1);
  });

  it('drops a replayed frame', async () => {
    const { client, link, hostAgree, ctrlAgree, hostSign, now } = await setup();
    client.requestView(); await tick();
    const { accept, sender } = await hostAccept(link, hostAgree, ctrlAgree.publicKey, hostSign.privateKey, now());
    link.toClientControl(accept); await tick();
    const f1 = await sender.seal(fakeFrame(1), now() + 1);
    const f2 = await sender.seal(fakeFrame(2), now() + 2);
    link.toClientFrame(f1); await tick();
    link.toClientFrame(f2); await tick();
    link.toClientFrame(f1); await tick();
    expect(client.getState().latestFrame!.seq).toBe(2);
    expect(client.getState().framesDecoded).toBe(2);
  });
});
