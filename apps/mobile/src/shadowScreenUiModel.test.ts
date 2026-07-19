import { describe, expect, it } from 'vitest';
import { deriveScreenViewModel, type ScreenUiInputs } from './shadowScreenUiModel';
import type { ScreenClientState } from './shadowScreenClient';

function clientState(over: Partial<ScreenClientState> = {}): ScreenClientState {
  return { phase: 'idle', sourceLabel: null, width: null, height: null, fps: null, reason: null, latestFrame: null, framesDecoded: 0, ...over };
}
function inputs(over: Partial<ScreenUiInputs> = {}): ScreenUiInputs {
  return { screenViewGranted: true, online: true, client: clientState(), hostName: "Jon’s Mac", configuredSourceLabel: 'Built-in Display · 1512×982', ...over };
}

describe('shadowScreenUiModel', () => {
  it('no-cap when screen.view was not granted (no dead Start button)', () => {
    const vm = deriveScreenViewModel(inputs({ screenViewGranted: false }));
    expect(vm.phase).toBe('no-cap');
    expect(vm.showViewButton).toBe(false);
    expect(vm.showFrame).toBe(false);
  });

  it('offline when the host is not reachable (view-only note still present)', () => {
    const vm = deriveScreenViewModel(inputs({ online: false }));
    expect(vm.phase).toBe('offline');
    expect(vm.showViewButton).toBe(false);
    expect(vm.viewOnlyNote).toBe('View only · no control or audio');
  });

  it('idle offers a View button + the configured source label', () => {
    const vm = deriveScreenViewModel(inputs());
    expect(vm.phase).toBe('idle');
    expect(vm.showViewButton).toBe(true);
    expect(vm.sourceLabel).toBe('Built-in Display · 1512×982');
  });

  it('requesting shows Stop but NO frame and NOT live (no optimistic live)', () => {
    const vm = deriveScreenViewModel(inputs({ client: clientState({ phase: 'requesting' }) }));
    expect(vm.phase).toBe('requesting');
    expect(vm.showStopButton).toBe(true);
    expect(vm.showFrame).toBe(false);
  });

  it('live ONLY when the client has a decoded frame; a live phase with no frame stays requesting', () => {
    const withFrame = deriveScreenViewModel(inputs({ client: clientState({ phase: 'live', latestFrame: { bytes: new Uint8Array([1]), codec: 'jpeg', width: 1280, height: 720, seq: 1, capturedAtMs: 1 } }) }));
    expect(withFrame.phase).toBe('live');
    expect(withFrame.showFrame).toBe(true);
    expect(withFrame.showStopButton).toBe(true);
    const noFrame = deriveScreenViewModel(inputs({ client: clientState({ phase: 'live', latestFrame: null }) }));
    expect(noFrame.phase).toBe('requesting');
    expect(noFrame.showFrame).toBe(false);
  });

  it('maps permission/busy/source-lost/revoked/expired/error truthfully', () => {
    for (const p of ['permission-required', 'permission-denied', 'busy', 'source-lost', 'revoked', 'expired', 'error'] as const) {
      const vm = deriveScreenViewModel(inputs({ client: clientState({ phase: p }) }));
      expect(vm.phase).toBe(p);
      expect(vm.showFrame).toBe(false);
    }
  });

  it('frame accessibility label names the source + Mac, never a window title/OCR', () => {
    const vm = deriveScreenViewModel(inputs({ client: clientState({ phase: 'live', sourceLabel: 'Built-in Display · 1512×982', latestFrame: { bytes: new Uint8Array([1]), codec: 'jpeg', width: 1280, height: 720, seq: 1, capturedAtMs: 1 } }) }));
    expect(vm.frameAccessibilityLabel).toBe('Live view of Built-in Display · 1512×982 on Jon’s Mac');
  });

  it('a terminal deny survives even when offline (truthful, not masked by offline)', () => {
    const vm = deriveScreenViewModel(inputs({ online: false, client: clientState({ phase: 'revoked' }) }));
    expect(vm.phase).toBe('revoked');
  });
});
