import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { nodeShadowCrypto } from '@maestro/realtime/shadowCryptoNode';
import {
  signScreenControl, deriveScreenStreamKey, decodeStreamNonce, ScreenFrameReceiver, freshStreamNonce,
  type ScreenControlBinding, type ScreenControlMessage, type ScreenSourcePolicy, type ScreenStreamBinding, type ScreenAuthoritySnapshot,
} from '@maestro/realtime/shadowScreenStream';
import { ScreenHostOwner, type NativeCaptureControl } from './shadow-screen-host-owner.js';
import { ScreenShareRegistry } from './shadow-screen-registry.js';
import type { ScreenRelayLink } from './shadow-screen-host.js';

const backend = nodeShadowCrypto;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const SOURCE: ScreenSourcePolicy = { sourcePolicyId: 'src_main', kind: 'display', label: 'Built-in Display · 1512×982', width: 1512, height: 982 };

class FakeLink implements ScreenRelayLink {
  controls: ScreenControlMessage[] = [];
  frames: Uint8Array[] = [];
  private ccb: ((raw: unknown) => void) | null = null;
  private dcb: (() => void) | null = null;
  sendControl(m: ScreenControlMessage) { this.controls.push(m); }
  sendFrame(e: Uint8Array) { this.frames.push(e); }
  onControl(cb: (raw: unknown) => void) { this.ccb = cb; }
  onDisconnect(cb: () => void) { this.dcb = cb; }
  deliver(m: unknown) { this.ccb?.(m); }
  disconnect() { this.dcb?.(); }
  accept() { return this.controls.find((c) => c.kind === 'screen-accept') as (ScreenControlMessage & { kind: 'screen-accept' }) | undefined; }
}

describe('ScreenHostOwner (B2) — production coordinator + native bridge + relay', () => {
  it('constructs the coordinator, drives native capture, seals a pushed frame to the relay, writes the registry', async () => {
    const hostAgree = await backend.generateAgreementKeyPair();
    const ctrlAgree = await backend.generateAgreementKeyPair();
    const hostSign = await backend.generateSigningKeyPair();
    const ctrlSign = await backend.generateSigningKeyPair();
    const link = new FakeLink();
    const registry = new ScreenShareRegistry();
    let nativeStarted = 0; let nativeStopped = 0;
    const native: NativeCaptureControl = {
      permission: () => 'granted',
      start: () => { nativeStarted += 1; },
      stop: () => { nativeStopped += 1; },
    };
    const authority: ScreenAuthoritySnapshot = {
      fence: { accountId: 'acc_1', scopeId: 'scope_1', hostDeviceId: 'host_1', epoch: 3, leaseId: 'lease_1' },
      leaseExpiresAtMs: 10 ** 15, grantedCapabilities: ['account.read', 'screen.view'], revokedControllerDeviceIds: [],
      hostOnline: true, configuredSourcePolicyId: 'src_main', foreground: true,
    };
    const owner = new ScreenHostOwner({
      backend,
      authority: {
        snapshot: () => authority,
        hostAgreementPrivate: () => hostAgree.privateKey,
        hostSigningPrivate: () => hostSign.privateKey,
        hostSigningKeyId: () => 'sk_host',
        controllerAgreementPublic: () => ctrlAgree.publicKey,
        controllerSigningPublic: () => ctrlSign.publicKey,
        sourcePolicy: () => SOURCE,
      },
      native, registry, dialRelay: () => link, now: () => 1_000_000, audit: () => {},
    });
    owner.start();
    // registry stop is registered by the owner (operator "Stop sharing" works)
    expect(nativeStarted).toBe(0);

    // Controller sends a SIGNED start.
    const binding: ScreenControlBinding = { accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15, streamId: 'stream_1' };
    const start: ScreenControlMessage = { kind: 'screen-start', v: 1, streamId: 'stream_1', accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', sourcePolicyId: 'src_main', requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: 8, controllerNonce: freshStreamNonce(backend).b64, requestedAt: 1_000_000, expiresAt: 1_060_000 };
    const signedStart = await signScreenControl(backend, ctrlSign.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: start, binding });
    link.deliver(signedStart);
    await tick(); await tick();

    // native capture started + a host-signed accept was sent
    expect(nativeStarted).toBe(1);
    const accept = link.accept();
    expect(accept).toBeTruthy();
    expect((accept as { signerRole?: string }).signerRole).toBe('host');
    expect(registry.get().active).toBe(true); // registry populated (banner/card go live)

    // A native frame arrives over the loopback seam → owner seals + relays it.
    owner.pushFrame(new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]), 1_000_001);
    await tick();
    expect(link.frames.length).toBe(1);

    // The controller can decrypt the relayed frame with the derived key.
    const strBinding: ScreenStreamBinding = { streamId: 'stream_1', accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15, sourcePolicyId: 'src_main', codec: 'jpeg', width: accept!.width, height: accept!.height };
    const key = await deriveScreenStreamKey({ backend, selfAgreementPrivate: ctrlAgree.privateKey, peerAgreementPublic: hostAgree.publicKey, hostNonce: decodeStreamNonce(accept!.hostNonce), controllerNonce: decodeStreamNonce((signedStart as { controllerNonce: string }).controllerNonce), binding: strBinding, keyEpoch: accept!.keyEpoch });
    const receiver = new ScreenFrameReceiver(backend, key, strBinding, accept!.keyEpoch, { expiresAtMs: accept!.expiresAt });
    const dec = await receiver.accept(link.frames[0]!, 1_000_002);
    expect(dec.ok).toBe(true);

    // Operator Stop sharing → native stop + registry cleared.
    await registry.stop();
    await tick();
    expect(nativeStopped).toBe(1);
    expect(registry.get().active).toBe(false);
  });
});

// A native adapter that behaves like the Swift seam: it reads ONLY the canonical
// `sourceId` field (never `sourcePolicyId`) and rejects a missing/empty id — exactly like
// `main.swift`. Used to prove the TS→native payload key matches what Swift reads (B2-R1).
class SwiftContractNative implements NativeCaptureControl {
  starts: string[] = [];
  errors: string[] = [];
  lastRawKeys: string[] = [];
  constructor(private readonly onError: (reason: string) => void) {}
  permission() { return 'granted' as const; }
  start(opts: { sourceId: string; codec: string; maxDimension: number; fps: number }): void {
    this.lastRawKeys = Object.keys(opts);
    // Swift: `guard let sourceID = params?["sourceId"], !sourceID.isEmpty else { return source-required }`
    const sourceID = typeof (opts as Record<string, unknown>).sourceId === 'string' ? (opts as { sourceId: string }).sourceId : '';
    if (!sourceID) { this.errors.push('source-required'); this.onError('source-required'); return; }
    this.starts.push(sourceID);
  }
  stop(): void {}
}

async function ownerWith(native: NativeCaptureControl, over: { source?: ScreenSourcePolicy | null; configuredId?: string | null } = {}) {
  const hostAgree = await backend.generateAgreementKeyPair();
  const ctrlAgree = await backend.generateAgreementKeyPair();
  const hostSign = await backend.generateSigningKeyPair();
  const ctrlSign = await backend.generateSigningKeyPair();
  const link = new FakeLink();
  const registry = new ScreenShareRegistry();
  const source = over.source === undefined ? SOURCE : over.source;
  const authority: ScreenAuthoritySnapshot = {
    fence: { accountId: 'acc_1', scopeId: 'scope_1', hostDeviceId: 'host_1', epoch: 3, leaseId: 'lease_1' },
    leaseExpiresAtMs: 10 ** 15, grantedCapabilities: ['account.read', 'screen.view'], revokedControllerDeviceIds: [],
    hostOnline: true, configuredSourcePolicyId: over.configuredId === undefined ? 'src_main' : over.configuredId, foreground: true,
  };
  const owner = new ScreenHostOwner({
    backend,
    authority: {
      snapshot: () => authority, hostAgreementPrivate: () => hostAgree.privateKey, hostSigningPrivate: () => hostSign.privateKey,
      hostSigningKeyId: () => 'sk_host', controllerAgreementPublic: () => ctrlAgree.publicKey, controllerSigningPublic: () => ctrlSign.publicKey,
      sourcePolicy: () => source,
    },
    native, registry, dialRelay: () => link, now: () => 1_000_000, audit: () => {},
  });
  owner.start();
  const binding: ScreenControlBinding = { accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', leaseExpiresAt: 10 ** 15, streamId: 'stream_1' };
  const start: ScreenControlMessage = { kind: 'screen-start', v: 1, streamId: 'stream_1', accountId: 'acc_1', hostDeviceId: 'host_1', controllerDeviceId: 'ctrl_1', grantId: 'grant_1', scopeId: 'scope_1', epoch: 3, leaseId: 'lease_1', sourcePolicyId: 'host-configured-display', requestedCodec: 'jpeg', requestedMaxDimension: 1280, requestedFps: 8, controllerNonce: freshStreamNonce(backend).b64, requestedAt: 1_000_000, expiresAt: 1_060_000 };
  const signed = await signScreenControl(backend, ctrlSign.privateKey, { role: 'controller', signerKeyId: 'sk_ctrl', controlNonce: freshStreamNonce(backend).b64, message: start, binding });
  link.deliver(signed);
  await tick(); await tick();
  return { owner, link, registry };
}

describe('ScreenHostOwner (B2-R1) — canonical native sourceId contract', () => {
  it('emits the native start with the canonical `sourceId` field (NOT sourcePolicyId) = the configured display', async () => {
    const swift = new SwiftContractNative(() => {});
    await ownerWith(swift);
    expect(swift.starts).toEqual(['src_main']);          // the Swift-contract adapter accepted the id
    expect(swift.lastRawKeys).toContain('sourceId');      // canonical field present
    expect(swift.lastRawKeys).not.toContain('sourcePolicyId'); // no alias on the native seam
  });

  it('the deferral sentinel resolves to the HOST-configured display id (remote never picks)', async () => {
    const swift = new SwiftContractNative(() => {});
    await ownerWith(swift, { source: { sourcePolicyId: 'display:7', kind: 'display', label: 'External · 2560×1440', width: 2560, height: 1440 }, configuredId: 'display:7' });
    expect(swift.starts).toEqual(['display:7']); // whatever the host confirmed, not the sentinel
  });

  it('no confirmed source → owner returns source-required BEFORE dialing native (no empty sourceId)', async () => {
    let errored = '';
    const swift = new SwiftContractNative((r) => { errored = r; });
    const { link } = await ownerWith(swift, { source: null, configuredId: null });
    expect(swift.starts.length).toBe(0);      // native never dialed
    expect(errored).toBe('');                 // and never with an empty id
    expect(link.controls.some((c) => c.kind === 'screen-status' && (c as { status?: string }).status === 'source-required')).toBe(true);
  });
});

describe('B2 production wiring (source contract — headless-main / renderer / swift / ws-host)', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, 'utf8');

  it('the SAME `sourceId` key flows TS→native and is what Swift READS (cross-language contract)', () => {
    const owner = read('./shadow-screen-host-owner.ts');
    const bridge = read('../renderer/lib/screenBridge.ts');
    const swift = read('../webview-app/Sources/MaestroWebKit/main.swift');
    const ctrl = read('../webview-app/Sources/MaestroWebKit/ScreenCaptureController.swift');
    // TS emits `sourceId` (the owner maps the confirmed source id into it)…
    expect(owner).toMatch(/native\.start\(\{\s*sourceId:/);
    // …the renderer forwards the payload verbatim to the native start…
    expect(bridge).toContain('bridge.screenCaptureStart?.(p)');
    // …and Swift reads EXACTLY `sourceId`, matching against the SCShareableContent id.
    expect(swift).toContain('params?["sourceId"]');
    expect(swift).not.toContain('params?["sourcePolicyId"]'); // the old mismatched key is gone
    expect(ctrl).toContain('config.sourceID');
    // Swift rejects an empty id up front (no silent fallback).
    expect(swift).toContain('"source-required"');
  });

  it('headless-main constructs the owner + dials the relay + routes the frame seam', () => {
    const h = read('../sidecar/src/headless-main.ts');
    expect(h).toContain("import { ScreenHostOwner }");
    expect(h).toContain('new ScreenHostOwner(');
    expect(h).toContain('ScreenRelayHostLink');
    expect(h).toContain("method === 'screenFrame'");
    expect(h).toContain('owner.pushFrame');
    expect(h).toContain('stopScreenHostOwner');
  });
  it('the owner registers the registry stop + writes status (not cosmetic)', () => {
    const o = read('./shadow-screen-host-owner.ts');
    expect(o).toContain('this.deps.registry.registerStop');
    expect(o).toContain('this.deps.registry.set');
    expect(o).toContain('new ScreenStreamHostCoordinator(');
  });
  it('the renderer DEFINES window.__maestroScreenFrame + relays to the brain', () => {
    const b = read('../renderer/lib/screenBridge.ts');
    expect(b).toContain('window.__maestroScreenFrame');
    expect(b).toContain("bridge.call('screenFrame'");
    expect(b).toContain("e.name === 'screen-capture-start'");
    const main = read('../renderer/main.tsx');
    expect(main).toContain('startScreenBridge()');
  });
  it('Swift exposes the native screen methods on window.maestro', () => {
    const swift = read('../webview-app/Sources/MaestroWebKit/main.swift');
    expect(swift).toContain('screenCaptureStart(p)');
    expect(swift).toContain('screenCapturePreflight()');
    expect(swift).toContain('window.__maestroScreenFrame');
  });

  it('M-A: the renderer does NOT auto-pick a source — it reports ids for revalidation only', () => {
    const bridge = read('../renderer/lib/screenBridge.ts');
    // no auto-configure of sources[0]
    expect(bridge).not.toMatch(/screenConfigureSource'?,\s*\{\s*sourcePolicyId:\s*main/);
    expect(bridge).not.toContain('sources?.[0]');
    // reports the available ids so the brain can revalidate the operator's persisted choice
    expect(bridge).toContain("bridge.call('screenReportSources'");
  });

  it('M-A: the brain persists an EXPLICIT selection + revalidates + clears (host-local)', () => {
    const h = read('../sidecar/src/headless-main.ts');
    expect(h).toContain('SCREEN_SOURCE_PATH');
    expect(h).toContain('persistScreenSourcePolicy');
    expect(h).toContain("method === 'screenConfigureSource'");
    expect(h).toContain("method === 'screenClearSource'");
    expect(h).toContain("method === 'screenReportSources'");
    // revalidation drops a persisted source no longer present
    expect(h).toMatch(/ids\.includes\(screenSourcePolicy\.sourcePolicyId\)/);
  });

  it('M-A: the Controllers source card offers explicit per-display confirmation (displays only)', () => {
    const card = read('../renderer/lib/ScreenSourceCard.tsx');
    expect(card).toContain('screenCaptureListSources');
    expect(card).toContain("bridge.call('screenConfigureSource'");
    expect(card).toContain('Use this display');
    // displays only — never enumerates windows / app names / titles
    expect(card).not.toMatch(/windowTitle|listWindows|appName|screenCaptureListWindows/i);
    const pane = read('../renderer/screens/ControllersPane.tsx');
    expect(pane).toContain('<ScreenSourceCard />');
  });

  it('M-A: the source card copy is TRUTHFUL — selection ≠ active sharing (no "Shared"/"Stop sharing")', () => {
    const card = read('../renderer/lib/ScreenSourceCard.tsx');
    // Selecting a display does NOT start a stream — the copy must say so.
    expect(card).toContain('Selected for view requests');
    expect(card).toContain('Clear selection');
    expect(card).toContain('Selecting it does not start sharing');
    // It must NOT claim the display is being shared or offer a stream "Stop sharing".
    expect(card).not.toContain('Shared — view only');
    expect(card).not.toContain('Stop sharing');     // that belongs ONLY to the active-stream ScreenShareCard
    expect(card).not.toMatch(/Nothing is shared until you pick one/);
  });
});
