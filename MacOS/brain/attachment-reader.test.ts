/**
 * Confined agent attachment reader — security + behavioral tests.
 *
 * RED-first: every test was written to FAIL before the implementation existed,
 * then turned GREEN by the production readAttachment().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAttachment, AttachmentError, DEFAULT_MAX_BYTES, EXT_MAP } from './attachment-reader.js';

let root: string;
let attachDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'attach-test-'));
  attachDir = join(root, '.continuum', 'Attachment');
  mkdirSync(attachDir, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Write a file inside the attachment dir and return its relative path. */
function stage(name: string, data: Buffer | string = 'hello'): string {
  const p = join(attachDir, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  return name;
}

// ────── Valid files ──────

describe('readAttachment — valid files', () => {
  it('reads a PNG by relative path and infers image kind', () => {
    const rel = stage('shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = readAttachment({ cwd: root, path: rel });
    expect(r.kind).toBe('image');
    expect(r.mimetype).toBe('image/png');
    expect(r.fileName).toBe('shot.png');
    expect(r.byteCount).toBe(4);
    expect(Buffer.compare(r.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(0);
  });

  it('reads by absolute path when it resolves inside attachment dir', () => {
    stage('doc.pdf', 'PDF content');
    const abs = join(attachDir, 'doc.pdf');
    const r = readAttachment({ cwd: root, path: abs });
    expect(r.kind).toBe('document');
    expect(r.mimetype).toBe('application/pdf');
    expect(r.fileName).toBe('doc.pdf');
  });

  it('reads a video file and infers video kind', () => {
    stage('clip.mp4', Buffer.alloc(100));
    const r = readAttachment({ cwd: root, path: 'clip.mp4' });
    expect(r.kind).toBe('video');
    expect(r.mimetype).toBe('video/mp4');
  });

  it('reads an audio file and infers audio kind', () => {
    stage('note.mp3', Buffer.alloc(50));
    const r = readAttachment({ cwd: root, path: 'note.mp3' });
    expect(r.kind).toBe('audio');
    expect(r.mimetype).toBe('audio/mpeg');
  });

  it('falls back to document kind for unknown extensions', () => {
    stage('data.xyz', 'binary stuff');
    const r = readAttachment({ cwd: root, path: 'data.xyz' });
    expect(r.kind).toBe('document');
    expect(r.mimetype).toBe('application/octet-stream');
  });

  it('reads from a subdirectory inside Attachment/', () => {
    stage('sub/dir/file.txt', 'nested');
    const r = readAttachment({ cwd: root, path: 'sub/dir/file.txt' });
    expect(r.fileName).toBe('file.txt');
    expect(r.data.toString()).toBe('nested');
  });
});

// ────── SEGMENT-AWARE PATH CONFINEMENT ──────

describe('readAttachment — segment-aware path confinement', () => {
  it('allows a child literally named "..foo" (not a traversal)', () => {
    stage('..foo', 'dotdot-prefixed');
    const r = readAttachment({ cwd: root, path: '..foo' });
    expect(r.fileName).toBe('..foo');
    expect(r.data.toString()).toBe('dotdot-prefixed');
  });

  it('allows a child named "..bar.txt"', () => {
    stage('..bar.txt', 'also ok');
    const r = readAttachment({ cwd: root, path: '..bar.txt' });
    expect(r.fileName).toBe('..bar.txt');
    expect(r.data.toString()).toBe('also ok');
  });

  it('rejects actual ".." traversal (segment boundary)', () => {
    writeFileSync(join(root, '.continuum', 'secret.txt'), 'private');
    expect(() => readAttachment({ cwd: root, path: '../secret.txt' }))
      .toThrow(AttachmentError);
  });
});

// ────── KIND/MIME TRUTH (finding 2) ──────

describe('readAttachment — kind/mime classification', () => {
  it('classifies PNG as image', () => {
    stage('img.png', Buffer.alloc(10));
    expect(readAttachment({ cwd: root, path: 'img.png' }).kind).toBe('image');
  });

  it('classifies JPEG as image', () => {
    stage('img.jpg', Buffer.alloc(10));
    expect(readAttachment({ cwd: root, path: 'img.jpg' }).kind).toBe('image');
  });

  it('classifies WebP as image', () => {
    stage('img.webp', Buffer.alloc(10));
    expect(readAttachment({ cwd: root, path: 'img.webp' }).kind).toBe('image');
  });

  it('classifies SVG as document (not image — WhatsApp may not render)', () => {
    stage('icon.svg', '<svg></svg>');
    const r = readAttachment({ cwd: root, path: 'icon.svg' });
    expect(r.kind).toBe('document');
    expect(r.mimetype).toBe('image/svg+xml');
  });

  it('classifies BMP as document (not image)', () => {
    stage('old.bmp', Buffer.alloc(10));
    const r = readAttachment({ cwd: root, path: 'old.bmp' });
    expect(r.kind).toBe('document');
  });

  it('classifies GIF as document (not image)', () => {
    stage('anim.gif', Buffer.alloc(10));
    const r = readAttachment({ cwd: root, path: 'anim.gif' });
    expect(r.kind).toBe('document');
  });

  it('EXT_MAP only classifies PNG/JPEG/WebP as image kind', () => {
    const imageExts = Object.entries(EXT_MAP)
      .filter(([, v]) => v.kind === 'image')
      .map(([k]) => k)
      .sort();
    expect(imageExts).toEqual(['.jpeg', '.jpg', '.png', '.webp']);
  });
});

// ────── Traversal / escape rejections ──────

describe('readAttachment — traversal / escape rejections', () => {
  it('rejects ../ traversal out of attachment dir', () => {
    writeFileSync(join(root, '.continuum', 'secret.txt'), 'private');
    expect(() => readAttachment({ cwd: root, path: '../secret.txt' }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: '../secret.txt' }); } catch (e) {
      expect((e as AttachmentError).code).toMatch(/traversal|not-found/);
    }
  });

  it('rejects absolute path outside attachment dir', () => {
    writeFileSync(join(root, 'outside.txt'), 'not here');
    expect(() => readAttachment({ cwd: root, path: join(root, 'outside.txt') }))
      .toThrow(AttachmentError);
  });

  it('rejects absolute path in /tmp', () => {
    const ext = mkdtempSync(join(tmpdir(), 'escape-'));
    writeFileSync(join(ext, 'bad.txt'), 'escape');
    try {
      expect(() => readAttachment({ cwd: root, path: join(ext, 'bad.txt') }))
        .toThrow(AttachmentError);
    } finally { rmSync(ext, { recursive: true, force: true }); }
  });
});

// ────── Symlink escape rejections ──────

describe('readAttachment — symlink escape rejections', () => {
  it('rejects a symlink inside Attachment/ pointing outside', () => {
    const ext = mkdtempSync(join(tmpdir(), 'sym-escape-'));
    writeFileSync(join(ext, 'secret.txt'), 'leaked');
    symlinkSync(join(ext, 'secret.txt'), join(attachDir, 'link.txt'));
    try {
      expect(() => readAttachment({ cwd: root, path: 'link.txt' }))
        .toThrow(AttachmentError);
    } finally { rmSync(ext, { recursive: true, force: true }); }
  });

  it('rejects a final-component symlink INSIDE Attachment/ pointing to another file INSIDE Attachment/ (in-root symlink)', () => {
    // This is the exact finding: link.txt -> real.txt, both inside Attachment/.
    // realpathSync resolves it to real.txt, so O_NOFOLLOW on the resolved path
    // opens the regular file and the symlink is silently accepted. The fix must
    // lstat the pre-resolved targetPath and reject if it's a symlink.
    writeFileSync(join(attachDir, 'real.txt'), 'real content');
    symlinkSync(join(attachDir, 'real.txt'), join(attachDir, 'link.txt'));
    expect(() => readAttachment({ cwd: root, path: 'link.txt' }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: 'link.txt' }); } catch (e) {
      expect((e as AttachmentError).code).toBe('symlink');
    }
  });

  it('rejects when .continuum/Attachment itself is a symlink (explicit root-symlink check)', () => {
    rmSync(attachDir, { recursive: true });
    const ext = mkdtempSync(join(tmpdir(), 'root-symlink-'));
    writeFileSync(join(ext, 'data.txt'), 'leaked');
    symlinkSync(ext, attachDir);
    try {
      expect(() => readAttachment({ cwd: root, path: 'data.txt' }))
        .toThrow(AttachmentError);
      try { readAttachment({ cwd: root, path: 'data.txt' }); } catch (e) {
        expect((e as AttachmentError).code).toBe('root-symlink');
      }
    } finally { rmSync(ext, { recursive: true, force: true }); }
  });
});

// ────── File type rejections ──────

describe('readAttachment — file type rejections', () => {
  it('rejects a directory target', () => {
    mkdirSync(join(attachDir, 'subdir'));
    expect(() => readAttachment({ cwd: root, path: 'subdir' }))
      .toThrow(AttachmentError);
  });

  it('rejects an empty file', () => {
    stage('empty.txt', '');
    expect(() => readAttachment({ cwd: root, path: 'empty.txt' }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: 'empty.txt' }); } catch (e) {
      expect((e as AttachmentError).code).toBe('empty');
    }
  });

  it('rejects a file over the custom byte cap', () => {
    stage('big.bin', Buffer.alloc(100));
    expect(() => readAttachment({ cwd: root, path: 'big.bin', maxBytes: 50 }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: 'big.bin', maxBytes: 50 }); } catch (e) {
      expect((e as AttachmentError).code).toBe('too-large');
    }
  });

  it('accepts a file at exactly the cap boundary', () => {
    stage('exact.bin', Buffer.alloc(50));
    const r = readAttachment({ cwd: root, path: 'exact.bin', maxBytes: 50 });
    expect(r.byteCount).toBe(50);
  });

  it('rejects a file 1 byte over the cap', () => {
    stage('over.bin', Buffer.alloc(51));
    expect(() => readAttachment({ cwd: root, path: 'over.bin', maxBytes: 50 }))
      .toThrow(AttachmentError);
  });
});

// ────── SIZE CLAIM (finding 3) ──────

describe('readAttachment — size cap semantics', () => {
  it('default cap is 16 MiB (agent safety cap, not WhatsApp protocol limit)', () => {
    expect(DEFAULT_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it('over-cap error says "agent safety cap", not "WhatsApp media cap"', () => {
    stage('big.bin', Buffer.alloc(100));
    try { readAttachment({ cwd: root, path: 'big.bin', maxBytes: 10 }); } catch (e) {
      expect((e as AttachmentError).message).toContain('agent safety cap');
      expect((e as AttachmentError).message).not.toContain('WhatsApp');
    }
  });
});

// ────── FAIL-CLOSED READ (finding 4) ──────

describe('readAttachment — fail-closed read', () => {
  it('rejects short read via injectable _readSync hook (simulates truncation)', () => {
    stage('trunc.bin', Buffer.alloc(100));
    // Injectable hook returns fewer bytes than requested on every call
    let callCount = 0;
    const shortRead = (fd: number, buf: Buffer, offset: number, length: number, position: number): number => {
      callCount++;
      if (callCount === 1) {
        // Return only 10 bytes instead of the full 100
        buf.fill(0xAA, offset, offset + 10);
        return 10;
      }
      // Return 0 (EOF) prematurely
      return 0;
    };
    expect(() => readAttachment({ cwd: root, path: 'trunc.bin', _readSync: shortRead }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: 'trunc.bin', _readSync: shortRead }); } catch (e) {
      expect((e as AttachmentError).code).toBe('short-read');
    }
  });

  it('succeeds when read returns exact size', () => {
    stage('exact.bin', Buffer.from('hello world'));
    const r = readAttachment({ cwd: root, path: 'exact.bin' });
    expect(r.byteCount).toBe(11);
    expect(r.data.toString()).toBe('hello world');
  });
});

// ────── Missing / invalid path ──────

describe('readAttachment — missing / invalid path', () => {
  it('rejects a non-existent file', () => {
    expect(() => readAttachment({ cwd: root, path: 'ghost.txt' }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: 'ghost.txt' }); } catch (e) {
      expect((e as AttachmentError).code).toBe('not-found');
    }
  });

  it('rejects empty string path', () => {
    expect(() => readAttachment({ cwd: root, path: '' }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: '' }); } catch (e) {
      expect((e as AttachmentError).code).toBe('invalid-path');
    }
  });

  it('rejects when .continuum/Attachment/ does not exist', () => {
    rmSync(attachDir, { recursive: true });
    expect(() => readAttachment({ cwd: root, path: 'anything.txt' }))
      .toThrow(AttachmentError);
    try { readAttachment({ cwd: root, path: 'anything.txt' }); } catch (e) {
      expect((e as AttachmentError).code).toBe('no-attachment-dir');
    }
  });
});

// ────── PATH PRIVACY (finding 5) ──────

describe('readAttachment — path privacy', () => {
  it('error for absolute path outside does not echo the supplied absolute path', () => {
    const sensitive = '/Users/example/secret.env';
    try { readAttachment({ cwd: root, path: sensitive }); } catch (e) {
      const msg = (e as AttachmentError).message;
      expect(msg).not.toContain('/Users');
      expect(msg).not.toContain('example');
      expect(msg).not.toContain('secret.env');
    }
  });

  it('error for traversal does not echo the supplied path', () => {
    writeFileSync(join(root, '.continuum', 'secret.txt'), 'private');
    try { readAttachment({ cwd: root, path: '../secret.txt' }); } catch (e) {
      const msg = (e as AttachmentError).message;
      expect(msg).not.toContain(root);
    }
  });

  it('error for missing file uses generic message, no path echo', () => {
    try { readAttachment({ cwd: root, path: 'nonexistent.txt' }); } catch (e) {
      const msg = (e as AttachmentError).message;
      expect(msg).toBe('File not found');
    }
  });

  it('error for symlink uses generic message, no path echo', () => {
    const ext = mkdtempSync(join(tmpdir(), 'sym-priv-'));
    writeFileSync(join(ext, 'x.txt'), 'data');
    symlinkSync(join(ext, 'x.txt'), join(attachDir, 'bad.txt'));
    try {
      try { readAttachment({ cwd: root, path: 'bad.txt' }); } catch (e) {
        const msg = (e as AttachmentError).message;
        expect(msg).not.toContain(ext);
      }
    } finally { rmSync(ext, { recursive: true, force: true }); }
  });
});

// ────── Filename sanitization ──────

describe('readAttachment — filename sanitization', () => {
  it('strips path separators from filenames', () => {
    stage('safe.txt', 'ok');
    const r = readAttachment({ cwd: root, path: 'safe.txt' });
    expect(r.fileName).not.toMatch(/[/\\]/);
  });
});
