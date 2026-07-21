import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ScreenViewerStore, type ScreenViewerClient } from './shadowScreenViewerStore';

class FakeClient implements ScreenViewerClient {
  requests = 0;
  stops = 0;
  requestView(): void { this.requests += 1; }
  stop(): void { this.stops += 1; }
}

describe('ScreenViewerStore (B1-R1) — attachment gates View + no silent no-op', () => {
  it('granted+online but UNATTACHED → View button hidden (Preparing…), never an actionable no-op', () => {
    const s = new ScreenViewerStore();
    s.setAuthority({ screenViewGranted: true, online: true });
    expect(s.isAttached()).toBe(false);
    const vm = s.getSnapshot().vm;
    expect(vm.showViewButton).toBe(false); // hidden until a real client is attached
    expect(vm.phase).toBe('idle');
    expect(vm.subtitle).toMatch(/Preparing/i);
  });

  it('unattached requestView() surfaces a truthful error — NOT a silent optional-chain no-op', () => {
    const s = new ScreenViewerStore();
    s.setAuthority({ screenViewGranted: true, online: true });
    s.requestView(); // no client attached
    expect(s.getSnapshot().vm.phase).toBe('error');
  });

  it('after attach: isAttached() true and the View button appears', () => {
    const s = new ScreenViewerStore();
    s.setAuthority({ screenViewGranted: true, online: true });
    const client = new FakeClient();
    s.attach(client);
    expect(s.isAttached()).toBe(true);
    expect(s.getSnapshot().vm.showViewButton).toBe(true);
    s.requestView();
    expect(client.requests).toBe(1); // routed to the real client, exactly once
  });

  it('detach(null) returns to idle and drops any frame', () => {
    const s = new ScreenViewerStore();
    s.setAuthority({ screenViewGranted: true, online: true });
    s.attach(new FakeClient());
    s.onClientState({ phase: 'live', sourceLabel: 'Display', width: 1280, height: 720, fps: 8, reason: null, latestFrame: { bytes: new Uint8Array([1, 2, 3]), codec: 'jpeg', width: 1280, height: 720, seq: 1, capturedAtMs: 1 }, framesDecoded: 1 });
    expect(s.getSnapshot().frameDataUri).not.toBeNull();
    s.attach(null); // detach
    expect(s.isAttached()).toBe(false);
    expect(s.getSnapshot().frameDataUri).toBeNull();
  });
});

describe('ScreenViewerStore (B1-R1) — ONE shared store (source contract)', () => {
  it('exactly one `new ScreenViewerStore()` exists, behind the singleton getter', () => {
    const VIEWER = readFileSync(new URL('./screens/controller/ScreenViewer.tsx', import.meta.url).pathname, 'utf8');
    const constructions = VIEWER.match(/new ScreenViewerStore\(/g) ?? [];
    expect(constructions.length).toBe(1); // the singleton in getScreenViewerStore()
    expect(VIEWER).toContain('function getScreenViewerStore');
    // ScreenSection obtains the SAME store, never its own instance.
    expect(VIEWER).toContain('getScreenViewerStore()');
  });

  it('the production runtime + the viewer share the exact same store instance', () => {
    const PROD = readFileSync(new URL('./shadowScreenRuntimeProd.ts', import.meta.url).pathname, 'utf8');
    // Prod runtime feeds getScreenViewerStore() as its store → identical instance to the UI.
    expect(PROD).toContain('getScreenViewerStore()');
    expect(PROD).not.toMatch(/new ScreenViewerStore\(/);
  });
});
