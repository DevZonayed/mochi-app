import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Regression guard: the tab transcript copy must stay on the canonical native
   copy path. The behavioral proof lives in ../lib/transcript-copy.test.ts; this
   pins the Workspace wiring so a future edit can't silently reintroduce the
   WebKit-rejected navigator.clipboard write or bypass the orchestration helper. */
const src = readFileSync(fileURLToPath(new URL('./Workspace.tsx', import.meta.url)), 'utf8');

describe('Workspace tab transcript copy — wiring', () => {
  it('never writes to navigator.clipboard directly (WebKit rejects it)', () => {
    expect(src).not.toMatch(/navigator\.clipboard/);
  });

  it('routes copy through the canonical orchestration helper', () => {
    expect(src).toContain('runTranscriptCopy(');
  });

  it('copies via the native pasteboard bridge wrapper', () => {
    expect(src).toContain('api.copyTextNative(');
  });

  it('both context-menu modes and the cmd-opt-C shortcut share copyTranscript', () => {
    // doMenuCopy (concise + full menu items) and the keydown handler both call it.
    const calls = src.match(/copyTranscript\(/g) ?? [];
    // doMenuCopy call + keyboard-shortcut call (the `const copyTranscript =`
    // definition is not a call and isn't counted).
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('only flashes the check after a confirmed ok (no optimistic success)', () => {
    // setMenuCopied must be guarded by an ok check, not called unconditionally.
    expect(src).toMatch(/outcome\.ok[\s\S]*setMenuCopied/);
  });

  it('coalesces rapid duplicate copies through the single-flight coordinator', () => {
    expect(src).toContain('createSingleFlight');
    expect(src).toContain('copyFlight.run(');
  });

  it('schedules delayed copy UI through the StrictMode-safe timer bag (not raw setTimeout)', () => {
    expect(src).toContain('useMountedTimerBag');
    // The copy flow's delayed resets must go through the re-armable bag accessor,
    // not window.setTimeout (which would leak past unmount).
    expect(src).toMatch(/setMenuCopied\(mode\)[\s\S]*timerBag\(\)\.set/);
  });

  it('guards post-copy state updates against an unmounted Workspace', () => {
    expect(src).toContain('mountedRef');
    // doMenuCopy bails before touching state when unmounted.
    expect(src).toMatch(/if \(!mountedRef\.current\) return/);
  });
});
