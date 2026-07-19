/* Binary sniffing for the file-read arm: NUL, known magic bytes, or a high ratio
   of disallowed control/invalid-UTF-8 bytes → binary. Must NOT misclassify UTF-8
   text (incl. multibyte emoji), JSON, or markdown. Pure-function unit tests. */
import { describe, it, expect } from 'vitest';
import { isBinarySample, mimeForPath } from './binary-detect.js';

describe('isBinarySample — magic + NUL + control-ratio', () => {
  it('flags a synthetic MP4/ftyp header (ftyp at offset 4)', () => {
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(isBinarySample(mp4)).toBe(true);
  });

  it('flags a PDF header with NO NUL byte (%PDF magic + high control ratio)', () => {
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj', 'latin1');
    expect(pdf.includes(0x00)).toBe(false);
    expect(isBinarySample(pdf)).toBe(true);
  });

  it('flags a PNG magic header', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    expect(isBinarySample(png)).toBe(true);
  });

  it('flags a JPEG magic header', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(isBinarySample(jpg)).toBe(true);
  });

  it('flags a ZIP magic header', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(isBinarySample(zip)).toBe(true);
  });

  it('flags a control-byte-heavy blob (no NUL, no magic)', () => {
    const blob = Buffer.alloc(200);
    for (let i = 0; i < blob.length; i++) blob[i] = i % 2 === 0 ? 0x01 : 0x41; // 50% SOH
    expect(isBinarySample(blob)).toBe(true);
  });

  it('does NOT flag UTF-8 text including multibyte emoji', () => {
    const text = Buffer.from('hello world — café 🚀🌟 déjà vu\nsecond line\ttabbed', 'utf8');
    expect(isBinarySample(text)).toBe(false);
  });

  it('does NOT flag JSON', () => {
    expect(isBinarySample(Buffer.from('{"a":1,"b":[true,null,"x"]}\n', 'utf8'))).toBe(false);
  });

  it('does NOT flag markdown / source', () => {
    expect(isBinarySample(Buffer.from('# Title\n\n- item `code`\n\n```ts\nconst x = 1;\n```\n', 'utf8'))).toBe(false);
  });

  it('does NOT flag an empty sample', () => {
    expect(isBinarySample(Buffer.alloc(0))).toBe(false);
  });
});

describe('mimeForPath — extension → MIME', () => {
  it('maps media and documents', () => {
    expect(mimeForPath('/x/final.mp4')).toBe('video/mp4');
    expect(mimeForPath('a.mov')).toBe('video/quicktime');
    expect(mimeForPath('a.webm')).toBe('video/webm');
    expect(mimeForPath('song.mp3')).toBe('audio/mpeg');
    expect(mimeForPath('v.wav')).toBe('audio/wav');
    expect(mimeForPath('doc.pdf')).toBe('application/pdf');
    expect(mimeForPath('i.PNG')).toBe('image/png');
    expect(mimeForPath('i.jpeg')).toBe('image/jpeg');
    expect(mimeForPath('i.svg')).toBe('image/svg+xml');
  });

  it('has MIME for every inline-classified media ext (avif/oga must not fall to octet-stream)', () => {
    // these are classified inline by the renderer; a missing MIME + nosniff would break them
    expect(mimeForPath('shot.avif')).toBe('image/avif');
    expect(mimeForPath('song.oga')).toBe('audio/ogg');
    expect(mimeForPath('a.ogg')).toBe('audio/ogg');
    expect(mimeForPath('a.m4a')).toBe('audio/mp4');
    expect(mimeForPath('a.flac')).toBe('audio/flac');
    expect(mimeForPath('a.m4v')).toBe('video/x-m4v');
    // none of these should be the octet-stream fallback
    for (const p of ['shot.avif', 'song.oga', 'a.ogg', 'a.m4a', 'a.flac', 'a.m4v']) {
      expect(mimeForPath(p)).not.toBe('application/octet-stream');
    }
  });

  it('maps common text types', () => {
    expect(mimeForPath('a.ts')).toBe('text/typescript');
    expect(mimeForPath('a.json')).toBe('application/json');
    expect(mimeForPath('README.md')).toBe('text/markdown');
    expect(mimeForPath('a.css')).toBe('text/css');
  });

  it('defaults unknown extensions to octet-stream', () => {
    expect(mimeForPath('a.weirdbin')).toBe('application/octet-stream');
    expect(mimeForPath('noext')).toBe('application/octet-stream');
  });
});
