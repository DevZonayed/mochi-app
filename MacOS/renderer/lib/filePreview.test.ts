import { describe, it, expect } from 'vitest';
import { previewKind, webkitCanInline, humanSize, mediaFallbackReason, type PreviewKind } from './filePreview';

describe('previewKind', () => {
  const cases: [string, PreviewKind][] = [
    ['clip.mp4', 'video'],
    ['/a/b/reel.MOV', 'video'],
    ['demo.webm', 'video'],
    ['old.mkv', 'video'],
    ['song.mp3', 'audio'],
    ['voice.wav', 'audio'],
    ['master.flac', 'audio'],
    ['doc.pdf', 'pdf'],
    ['logo.png', 'image'],
    ['icon.svg', 'image'],
    ['photo.JPEG', 'image'],
    ['main.ts', 'text'],
    ['data.json', 'text'],
    ['notes.md', 'text'],
    ['run.sh', 'text'],
    ['mystery.bin', 'binary'],
    ['archive.zip', 'binary'],
    ['noext', 'binary'],
  ];
  for (const [name, kind] of cases) {
    it(`${name} → ${kind}`, () => { expect(previewKind(name)).toBe(kind); });
  }
});

describe('webkitCanInline', () => {
  it('mkv is NOT inline (container WebKit cannot play)', () => {
    expect(webkitCanInline(previewKind('a.mkv'), 'a.mkv')).toBe(false);
  });
  it('mp4 is inline', () => {
    expect(webkitCanInline(previewKind('a.mp4'), 'a.mp4')).toBe(true);
  });
  it('mov / webm are inline', () => {
    expect(webkitCanInline(previewKind('a.mov'), 'a.mov')).toBe(true);
    expect(webkitCanInline(previewKind('a.webm'), 'a.webm')).toBe(true);
  });
  it('pdf is inline', () => {
    expect(webkitCanInline(previewKind('a.pdf'), 'a.pdf')).toBe(true);
  });
  it('image + audio are inline', () => {
    expect(webkitCanInline('image', 'a.png')).toBe(true);
    expect(webkitCanInline('audio', 'a.mp3')).toBe(true);
  });
  it('SVG is NOT inlined (served inert for safety → metadata fallback)', () => {
    expect(previewKind('logo.svg')).toBe('image');
    expect(webkitCanInline(previewKind('logo.svg'), 'logo.svg')).toBe(false);
  });
  it('avif is an inline image, oga is inline audio (both have real MIME)', () => {
    expect(previewKind('shot.avif')).toBe('image');
    expect(webkitCanInline(previewKind('shot.avif'), 'shot.avif')).toBe(true);
    expect(previewKind('song.oga')).toBe('audio');
    expect(webkitCanInline(previewKind('song.oga'), 'song.oga')).toBe(true);
  });
});

describe('mediaFallbackReason (honest fallback text)', () => {
  it('a decode/load failure points at the default app', () => {
    const r = mediaFallbackReason({ streamUrl: 'http://x/files/stream?...', decodeFailed: true });
    expect(r).toMatch(/couldn.t decode/i);
    expect(r).toMatch(/default app/i);
  });
  it('no stream URL (browser build) is stated plainly', () => {
    expect(mediaFallbackReason({ streamUrl: null, decodeFailed: false })).toMatch(/desktop app/i);
  });
  it('an unsupported type (no failure yet) is honest but not alarming', () => {
    const r = mediaFallbackReason({ streamUrl: 'http://x', decodeFailed: false });
    expect(r).toMatch(/can.t be previewed inline/i);
    expect(r).not.toMatch(/decode/i);
  });
  it('binary is not inline', () => {
    expect(webkitCanInline('binary', 'a.zip')).toBe(false);
  });
  it('text is not treated as inline media (source view handles it)', () => {
    expect(webkitCanInline('text', 'a.ts')).toBe(false);
  });
});

describe('humanSize', () => {
  it('bytes under 1 KiB stay in B', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(512)).toBe('512 B');
    expect(humanSize(1023)).toBe('1023 B');
  });
  it('formats KB/MB with a lean decimal', () => {
    expect(humanSize(1024)).toBe('1 KB');
    expect(humanSize(1536)).toBe('1.5 KB');
    expect(humanSize(1048576)).toBe('1 MB');
    expect(humanSize(5 * 1048576)).toBe('5 MB');
  });
  it('handles bad input gracefully', () => {
    expect(humanSize(-1)).toBe('—');
    expect(humanSize(NaN)).toBe('—');
  });
});
