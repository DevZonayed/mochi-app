// Source-contract test for the file-artifact wiring across the renderer. The
// full Workspace/ProjectDetail components are far too large to mount headless,
// so we assert the integration seams directly from source — this locks the
// sessionId propagation and the native Copy/Reveal/Open actions against
// regressions. (The pure classifier behavior is covered in filePreview.test.ts.)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(HERE, '..', rel), 'utf8');

describe('Workspace threads sessionId into file tabs + FileViewer', () => {
  const src = read('screens/Workspace.tsx');
  it('openFile accepts a sessionId and stores it on the file tab', () => {
    expect(src).toMatch(/openFile\s*=\s*\(projectId:\s*string,\s*filePath:\s*string,\s*sessionId/);
    expect(src).toMatch(/kind:\s*'file'/);
  });
  it('dedupe key includes projectId, sessionId AND the (canonical) path', () => {
    expect(src).toMatch(/fileTabKey\s*=\s*\(projectId[^)]*sessionId[^)]*filePath/);
  });
  it('renders FileViewer with the tab sessionId and a canonical-path callback', () => {
    expect(src).toMatch(/<FileViewer[^>]*sessionId=\{t\.sessionId/);
    expect(src).toMatch(/onCanonical=\{c =>/);
  });
  it('ChatThread onOpenFile forwards the resolved sessionId to openFile', () => {
    expect(src).toMatch(/onOpenFile=\{\(filePath,\s*sessionId\)\s*=>\s*openFile\(/);
  });
});

describe('ProjectDetail PathLink carries the active session id through the open callback', () => {
  const src = read('screens/ProjectDetail.tsx');
  it('ChatThread onOpenFile signature includes an optional sessionId', () => {
    expect(src).toMatch(/onOpenFile\?:\s*\(filePath:\s*string,\s*sessionId\?/);
  });
  it('the stable path opener forwards the CURRENT active session id', () => {
    expect(src).toMatch(/handler\(p,\s*openActiveIdRef\.current\)/);
    expect(src).toMatch(/openActiveIdRef\.current\s*=\s*activeId/);
  });
  it('file-artifact reveal is CONFINED (revealFile), never the raw trusted reveal', () => {
    // ⌘-click reveal + the no-handler fallback both go through the confined op
    expect(src).toMatch(/api\.revealFile\(pid,\s*p,\s*sid\)/);
    expect(src).toMatch(/api\.revealFile\('',\s*path\)/);
    // the raw native reveal is only used for trusted app-owned paths (image asset,
    // project folder) — never a transcript path handed straight to api.revealPath
    expect(src).not.toMatch(/api\.revealPath\(p\)/);
    expect(src).not.toMatch(/api\.revealPath\(pid,/);
  });
});

describe('CodeView FileViewer: binary previews, no source/garbage, native actions', () => {
  const src = read('lib/CodeView.tsx');
  it('reads through the session-scoped readFile and builds a session-scoped stream URL', () => {
    expect(src).toMatch(/api\.readFile\(projectId,\s*filePath,\s*sessionId\)/);
    expect(src).toMatch(/api\.fileStreamUrl\(projectId,\s*canonical,\s*sessionId\)/);
  });
  it('classifies binary and never offers Source/Edit for it', () => {
    expect(src).toMatch(/isBinary\s*=\s*!!data\s*&&\s*\(data\.binary/);
    // the source/edit toggle must be gated on NOT binary
    expect(src).toMatch(/!isBinary/);
  });
  it('renders first-class media via the stream URL (img/video/audio/pdf embed)', () => {
    expect(src).toMatch(/<video\s+src=\{streamUrl\}/);
    expect(src).toMatch(/<audio\s+src=\{streamUrl\}/);
    expect(src).toMatch(/<embed\s+src=\{streamUrl\}[^>]*application\/pdf/);
    expect(src).toMatch(/<img\s+src=\{streamUrl\}/);
  });
  it('has a truthful metadata fallback with Copy path / Reveal / Open with default', () => {
    expect(src).toMatch(/Copy path/);
    expect(src).toMatch(/Reveal in Finder/);
    expect(src).toMatch(/Open with default app/);
    expect(src).toMatch(/humanSize\(bytes\)/);
  });
  it('surfaces success/error toasts (does not silently swallow bridge failures) + Retry', () => {
    expect(src).toMatch(/setToast\(/);
    expect(src).toMatch(/aria-live=/);
    expect(src).toMatch(/Retry/);
  });
  it('img/video/audio have an onError fallback; pdf embed does NOT (embed onError is unreliable)', () => {
    // decodable-media elements wire onError to the failure setter
    expect(src).toMatch(/<img\s+src=\{streamUrl\}[^>]*onError=\{onMediaError\}/);
    expect(src).toMatch(/<video\s+src=\{streamUrl\}[^>]*onError=\{onMediaError\}/);
    expect(src).toMatch(/<audio\s+src=\{streamUrl\}[^>]*onError=\{onMediaError\}/);
    // the pdf <embed> must NOT carry onError (would spuriously flip a working PDF)
    expect(src).toMatch(/<embed\s+src=\{streamUrl\}[^>]*application\/pdf/);
    expect(src).not.toMatch(/<embed[^>]*onError/);
    // inline branch gated on NOT decodeFailed; failure resets on the deterministic
    // canonical path (not a URL that could gain a nonce) — fallback has no media
    // element, so no remount loop
    expect(src).toMatch(/canInline\s*&&\s*streamUrl\s*&&\s*!decodeFailed/);
    expect(src).toMatch(/setDecodeFailed\(false\)\s*;?\s*\}\s*,\s*\[canonical\]\)/);
    // the honest reason comes from the shared helper
    expect(src).toMatch(/mediaFallbackReason\(\{\s*streamUrl,\s*decodeFailed\s*\}\)/);
  });
  it('gates artifact Reveal/Open on the CONFINED capability + calls the confined ops', () => {
    // the file-artifact controls must be gated on the exact confined operation
    expect(src).toMatch(/api\.canRevealFile\(\)/);
    expect(src).toMatch(/api\.canOpenFile\(\)/);
    expect(src).not.toMatch(/api\.canOpenWithDefault\(\)/);
    expect(src).toMatch(/api\.revealFile\(projectId,\s*canonical,\s*sessionId\)/);
    expect(src).toMatch(/api\.openWithDefault\(projectId,\s*canonical,\s*sessionId\)/);
  });
});

describe('api.ts bridge: native-first with safe non-WebKit degradation', () => {
  const src = read('lib/api.ts');
  it('trusted app-owned reveal prefers the native bridge (reveal ?? revealPath)', () => {
    expect(src).toMatch(/bridge\?\.reveal\s*\?\?\s*bridge\?\.revealPath/);
    expect(src).toMatch(/canReveal:/);
  });
  it('exposes CONFINED file-artifact capabilities gated on the exact confined bridge methods', () => {
    expect(src).toMatch(/canRevealFile:\s*\(\):\s*boolean\s*=>\s*Boolean\(bridge\?\.revealFile\)/);
    expect(src).toMatch(/canOpenFile:\s*\(\):\s*boolean\s*=>\s*Boolean\(bridge\?\.openFile\)/);
    // the confined wrappers call the confined bridge methods (not the trusted ones)
    expect(src).toMatch(/if \(!bridge\?\.revealFile\)/);
    expect(src).toMatch(/if \(!bridge\?\.openFile\)/);
  });
  it('copyText falls back to navigator.clipboard when no native bridge', () => {
    expect(src).toMatch(/copyTextNative/);
    expect(src).toMatch(/navigator[^\n]*clipboard/);
  });
  it('fileStreamUrl returns null without a bridge (no crash in browser builds)', () => {
    expect(src).toMatch(/fileStreamUrl:[^\n]*:\s*string\s*\|\s*null/);
    expect(src).toMatch(/if \(!bridge\?\.fileStreamUrl\) return null/);
  });
  it('readFile threads the sessionId through to the bridge', () => {
    expect(src).toMatch(/readFile\?:[^\n]*sessionId\?/);
  });
});
