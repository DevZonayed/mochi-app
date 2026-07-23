// Source-contract test for the native AppKit bridge in main.swift.
//
// Full AppKit UI behavior can't be exercised headless, so instead we read
// main.swift as text and lock the contract that both sides of the bridge
// (the Swift `didReceive` switch + the injected `window.maestro` JS) must
// keep in sync: native copy/reveal/open handlers and the JS methods that
// call them. This catches accidental removal or rename without a device.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SWIFT = readFileSync(
  fileURLToPath(new URL('./Sources/MaestroWebKit/main.swift', import.meta.url)),
  'utf8',
);

const SCREEN = readFileSync(
  fileURLToPath(new URL('./Sources/MaestroWebKit/ScreenCaptureController.swift', import.meta.url)),
  'utf8',
);

describe('native bridge — Swift switch cases', () => {
  it('handles nativeCopy, nativeReveal, nativeOpen', () => {
    expect(SWIFT).toContain('case "nativeCopy"');
    expect(SWIFT).toContain('case "nativeReveal"');
    expect(SWIFT).toContain('case "nativeOpen"');
  });

  it('keeps the existing pickFolder / importAsset cases intact', () => {
    expect(SWIFT).toContain('case "pickFolder"');
    expect(SWIFT).toContain('case "importAsset"');
  });

  it('exposes the Phase 3D1 view-only screen-capture bridge (preflight/list/start/stop)', () => {
    expect(SWIFT).toContain('case "screenCapturePreflight"');
    expect(SWIFT).toContain('case "screenCaptureListSources"');
    expect(SWIFT).toContain('case "screenCaptureStart"');
    expect(SWIFT).toContain('case "screenCaptureStop"');
  });
});

describe('screen capture — real ScreenCaptureKit path (Phase 3D1)', () => {
  it('imports ScreenCaptureKit and uses the real SCStream capture path', () => {
    expect(SCREEN).toContain('import ScreenCaptureKit');
    expect(SCREEN).toContain('SCStream(');
    expect(SCREEN).toContain('SCStreamConfiguration()');
    expect(SCREEN).toContain('SCContentFilter(');
    expect(SCREEN).toContain('addStreamOutput(');
    expect(SCREEN).toContain('startCapture()');
    expect(SCREEN).toContain('SCStreamOutput');
  });

  it('is availability-guarded to the macOS 14 deployment floor', () => {
    expect(SCREEN).toContain('@available(macOS 14.0, *)');
  });

  it('NEVER captures audio and defaults the cursor OFF', () => {
    expect(SCREEN).toContain('cfg.capturesAudio = false');
    expect(SCREEN).toContain('cfg.showsCursor = config.showsCursor');
    // the start config threads showsCursor with a default of false at the call site
    expect(SWIFT).toContain('(params?["showsCursor"] as? Bool) ?? false');
  });

  it('preflights permission WITHOUT prompting (CGPreflightScreenCaptureAccess)', () => {
    expect(SCREEN).toContain('CGPreflightScreenCaptureAccess()');
    // must not auto-request/prompt inside preflight
    const preflightBody = SCREEN.slice(SCREEN.indexOf('func screenCapturePermissionState'), SCREEN.indexOf('func screenCapturePermissionState') + 400);
    expect(preflightBody).not.toContain('CGRequestScreenCaptureAccess');
  });

  it('aspect-fits to a max dimension of 1280 and clamps fps to 2...60', () => {
    expect(SCREEN).toContain('min(config.maxDimension, 1280)');
    expect(SCREEN).toContain('max(2, min(config.fps, 60))');
  });

  it('has NO synthetic-input / CGEvent / accessibility path anywhere in the capture bridge', () => {
    for (const forbidden of ['CGEvent', 'CGEventPost', 'AXUIElement', 'postEvent', 'keyboardEvent', 'mouseEvent', 'CGWarpMouseCursorPosition']) {
      expect(SCREEN).not.toContain(forbidden);
    }
    // frames only flow OUT to the renderer; no reverse input hook
    expect(SWIFT).toContain('window.__maestroScreenFrame');
  });
});

describe('native bridge — Swift AppKit implementations', () => {
  it('nativeCopy uses NSPasteboard', () => {
    expect(SWIFT).toContain('NSPasteboard');
  });

  it('nativeReveal uses NSWorkspace.shared.activateFileViewerSelecting', () => {
    expect(SWIFT).toContain('NSWorkspace.shared.activateFileViewerSelecting');
  });

  it('nativeOpen uses NSWorkspace.shared.open', () => {
    expect(SWIFT).toContain('NSWorkspace.shared.open');
  });

  it('reveal/open validate existence with FileManager.default.fileExists', () => {
    expect(SWIFT).toContain('FileManager.default.fileExists');
  });
});

describe('safeStorage master key — Security.framework provisioning + env injection', () => {
  it('provisions the key via Security.framework (SecItemCopyMatching / SecItemAdd)', () => {
    expect(SWIFT).toContain('import Security');
    expect(SWIFT).toContain('SecItemCopyMatching');
    expect(SWIFT).toContain('SecItemAdd');
    expect(SWIFT).toContain('kSecClassGenericPassword');
  });

  it('generates a random 32-byte key with SecRandomCopyBytes', () => {
    expect(SWIFT).toContain('SecRandomCopyBytes');
    expect(SWIFT).toMatch(/keyLength\s*=\s*32/);
  });

  it('scopes the Keychain service to THIS channel (bundle id) — channels never share a key', () => {
    expect(SWIFT).toMatch(/Bundle\.main\.bundleIdentifier[^\n]*\.safeStorage/);
  });

  it('stores the item local-only (AfterFirstUnlockThisDeviceOnly — never iCloud-synced)', () => {
    expect(SWIFT).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
  });

  it('injects the base64 key ONLY via the MAESTRO_SAFE_STORAGE_KEY env var', () => {
    expect(SWIFT).toMatch(/env\["MAESTRO_SAFE_STORAGE_KEY"\]\s*=\s*safeStorageKeyB64/);
    expect(SWIFT).toContain('SafeStorageKey.provisionBase64()');
  });

  it('on errSecDuplicateItem re-loads the EXISTING item (never returns a non-persisted fresh key)', () => {
    // SecItemAdd does not overwrite; a duplicate means the stored key differs
    // from `fresh`, so provision must return the loaded existing key, not fresh.
    expect(SWIFT).toContain('errSecDuplicateItem');
    expect(SWIFT).toMatch(/case \.duplicate:/);
    const dupBody = SWIFT.slice(SWIFT.indexOf('case .duplicate:'), SWIFT.indexOf('case .failed:'));
    expect(dupBody).toMatch(/load\(\)/);              // re-loads the existing item
    expect(dupBody).not.toMatch(/fresh\.base64/);      // never returns the un-persisted fresh key
  });

  it('NEVER logs the key or the whole environment (only exec/args/cwd are logged)', () => {
    // No DebugLog line may reference the key var or the env dictionary.
    const logLines = SWIFT.split('\n').filter(l => l.includes('DebugLog.write'));
    for (const l of logLines) {
      expect(l).not.toContain('MAESTRO_SAFE_STORAGE_KEY');
      expect(l).not.toContain('safeStorageKeyB64');
      expect(l).not.toMatch(/DebugLog\.write\([^)]*\benv\b/);
    }
    // The provisioned key is passed to env, never printed/echoed.
    expect(SWIFT).not.toMatch(/print\([^)]*safeStorageKeyB64/);
  });
});

describe('native bridge — injected window.maestro JS', () => {
  it('exposes copyText, reveal, openPath, fileStreamUrl', () => {
    expect(SWIFT).toContain('copyText(text)');
    expect(SWIFT).toContain('reveal(path)');
    expect(SWIFT).toContain('openPath(path)');
    expect(SWIFT).toContain('fileStreamUrl(projectId, path, sessionId)');
  });

  it('routes revealPath through the native nativeReveal method (back-compat)', () => {
    expect(SWIFT).toMatch(/revealPath\(path\)\s*\{\s*return nativeRequest\('nativeReveal'/);
  });

  it('fileStreamUrl builds the sidecar /files/stream route with a token', () => {
    expect(SWIFT).toContain('/files/stream?token=');
  });

  it('CONFINED revealFile/openFile resolve via resolveFilePath BEFORE the native action', () => {
    expect(SWIFT).toMatch(/async revealFile\(projectId, path, sessionId\)/);
    expect(SWIFT).toMatch(/async openFile\(projectId, path, sessionId\)/);
    const revealBody = SWIFT.slice(SWIFT.indexOf('async revealFile'), SWIFT.indexOf('async openFile'));
    expect(revealBody).toMatch(/call\('resolveFilePath'/);
    expect(revealBody).toMatch(/nativeRequest\('nativeReveal', \{ path: g\.data\.path \}\)/);
    const openBody = SWIFT.slice(SWIFT.indexOf('async openFile'));
    expect(openBody).toMatch(/call\('resolveFilePath'/);
    expect(openBody).toMatch(/nativeRequest\('nativeOpen', \{ path: g\.data\.path \}\)/);
    // the confined flow must NOT reach the native raw path via the old brain names
    expect(revealBody).not.toMatch(/call\('revealPath'/);
  });
});
