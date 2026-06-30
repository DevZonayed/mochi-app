/* Unit tests for the per-project attachments store.
   Verifies: save under .continuum/Attachment/, `«attach:id»` → `@<absPath>`
   substitution, and the relay scrub that strips the operator's home directory. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveAttachment, substitutePlaceholders, scrubAbsPathsForRelay, attachmentsDirFor, placeholderFor } from './attachments.js';

describe('attachments', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(path.join(tmpdir(), 'maestro-attach-')); });
  afterEach(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* gone */ } });

  it('saves a pasted text file under .continuum/Attachment/ with the chip id suffix', () => {
    const saved = saveAttachment(cwd, { id: '1734550000-abc12', kind: 'text', name: 'Pasted text.txt', content: 'hello world' });
    // Directory + filename shape match the user's exact requested form.
    expect(saved.absPath).toMatch(/\/\.continuum\/Attachment\/Pasted_text_abc12\.txt$/);
    expect(existsSync(saved.absPath)).toBe(true);
    expect(readFileSync(saved.absPath, 'utf8')).toBe('hello world');
    expect(saved.kind).toBe('text');
    expect(saved.bytes).toBe('hello world'.length);
  });

  it('saves an image with png ext + chip id suffix; normalizes jpeg → jpg', () => {
    const png = saveAttachment(cwd, { id: 'x-aaaaa', kind: 'image', name: 'shot.png', bytes: Buffer.from([0x89, 0x50, 0x4E, 0x47]) });
    expect(png.absPath).toMatch(/shot_aaaaa\.png$/);
    expect(statSync(png.absPath).size).toBe(4);
    const jpg = saveAttachment(cwd, { id: 'y-bbbbb', kind: 'image', name: 'photo.jpeg', bytes: Buffer.from([0xFF, 0xD8]) });
    expect(jpg.absPath).toMatch(/photo_bbbbb\.jpg$/);
  });

  it('saves a binary file with the chip id suffix + original ext', () => {
    const saved = saveAttachment(cwd, { id: '999-ccccc', kind: 'file', name: 'spec.pdf', bytes: Buffer.from('%PDF-1.4') });
    expect(saved.absPath).toMatch(/spec_ccccc\.pdf$/);
    expect(readFileSync(saved.absPath, 'utf8')).toBe('%PDF-1.4');
  });

  it('attachmentsDirFor creates the dir on demand and is idempotent', () => {
    const d = attachmentsDirFor(cwd);
    expect(d).toBe(path.join(cwd, '.continuum', 'Attachment'));
    expect(existsSync(d)).toBe(true);
    // Second call returns the same path without throwing.
    expect(attachmentsDirFor(cwd)).toBe(d);
  });

  it('refuses to save when no bytes/content/srcPath is given', () => {
    expect(() => saveAttachment(cwd, { id: 'a-b', kind: 'file', name: 'empty.bin' })).toThrowError(/no bytes/);
  });

  it('placeholderFor + substitutePlaceholders round-trips «attach:id» → @<absPath>', () => {
    const ph = placeholderFor('1734550000-abc12');
    expect(ph).toBe('«attach:1734550000-abc12»');
    const prompt = `look at ${ph} and tell me what's broken`;
    const map = new Map([['1734550000-abc12', '/Users/me/proj/.continuum/Attachment/Pasted_text_abc12.txt']]);
    expect(substitutePlaceholders(prompt, map))
      .toBe(`look at @/Users/me/proj/.continuum/Attachment/Pasted_text_abc12.txt and tell me what's broken`);
  });

  it('substitutePlaceholders preserves chip POSITION across multiple attachments', () => {
    const prompt = `first «attach:i-1», then some prose, then «attach:i-2» the end`;
    const map = new Map([
      ['i-1', '/tmp/p/.continuum/Attachment/a_1.png'],
      ['i-2', '/tmp/p/.continuum/Attachment/b_2.txt'],
    ]);
    expect(substitutePlaceholders(prompt, map))
      .toBe('first @/tmp/p/.continuum/Attachment/a_1.png, then some prose, then @/tmp/p/.continuum/Attachment/b_2.txt the end');
  });

  it('substitutePlaceholders drops unknown ids defensively (a stale chip with no payload)', () => {
    expect(substitutePlaceholders('keep «attach:gone» dropped', new Map())).toBe('keep  dropped');
  });

  it('scrubAbsPathsForRelay rewrites every @<abs>/.continuum/Attachment/<name> to @.continuum/Attachment/<name>', () => {
    const text = 'check @/Users/jonayed/Desktop/TestProject/.continuum/Attachment/pested_text_35345.txt and then @/Volumes/Work/myrepo/.continuum/Attachment/shot_xy.png';
    expect(scrubAbsPathsForRelay(text))
      .toBe('check @.continuum/Attachment/pested_text_35345.txt and then @.continuum/Attachment/shot_xy.png');
  });

  it('scrubAbsPathsForRelay leaves non-attachment paths alone (no surprise rewriting)', () => {
    const text = 'open @/Users/me/projects/foo.txt please';
    expect(scrubAbsPathsForRelay(text)).toBe(text);
  });

  it('scrubAbsPathsForRelay handles project folders with SPACES in the prefix', () => {
    // Regression: image_37flq.png — the bubble used to render the raw `@<path>`
    // as an underlined link instead of a pill because the path prefix
    // contained spaces (`Client Shared GIT/`) and the old `[^\s]+` regex
    // refused to match. Verified against the relay scrub here, and the same
    // widened pattern is used by the bubble's `ATTACH_INLINE_RE`.
    const text = 'here is @/Users/jonayed/Desktop/Projects/Nexalance/Client Shared GIT/veni0004/.continuum/Attachment/Pasted_text_ckxg1.txt , thanks';
    expect(scrubAbsPathsForRelay(text))
      .toBe('here is @.continuum/Attachment/Pasted_text_ckxg1.txt , thanks');
  });

  it('scrubAbsPathsForRelay preserves a sub-directory under Attachment/ (legacy per-session layout)', () => {
    const text = 'see @/Users/me/proj/.continuum/Attachment/dresden/Pasted_text_ckxg1.txt now';
    expect(scrubAbsPathsForRelay(text))
      .toBe('see @.continuum/Attachment/dresden/Pasted_text_ckxg1.txt now');
  });

  it('scrubAbsPathsForRelay scrubs BOTH a spaced + sub-dir path AND a trailing extra path on one line', () => {
    const text = 'A @/Users/jonayed/Client Shared GIT/p/.continuum/Attachment/sub/a.png and B @/tmp/q/.continuum/Attachment/b.txt done';
    expect(scrubAbsPathsForRelay(text))
      .toBe('A @.continuum/Attachment/sub/a.png and B @.continuum/Attachment/b.txt done');
  });

  it('saveAttachment with the SAME id rewrites the same file (idempotent re-save)', () => {
    const a = saveAttachment(cwd, { id: 'same-id', kind: 'text', name: 'note.txt', content: 'one' });
    const b = saveAttachment(cwd, { id: 'same-id', kind: 'text', name: 'note.txt', content: 'two' });
    expect(b.absPath).toBe(a.absPath);
    expect(readFileSync(b.absPath, 'utf8')).toBe('two');
  });

  it('saveAttachment kind=ref copies the source file into the attachments folder', () => {
    const src = path.join(cwd, 'src.txt');
    writeFileSync(src, 'original-bytes');
    const saved = saveAttachment(cwd, { id: 'r-rrrr', kind: 'ref', name: 'src.txt', srcPath: src });
    expect(saved.absPath).not.toBe(src); // it was copied, not symlinked
    expect(saved.absPath).toMatch(/src_rrrr\.txt$/);
    expect(readFileSync(saved.absPath, 'utf8')).toBe('original-bytes');
    // Source is untouched.
    expect(readFileSync(src, 'utf8')).toBe('original-bytes');
  });

  it('sanitizes unsafe characters in the filename', () => {
    const saved = saveAttachment(cwd, { id: '1-zzzzz', kind: 'text', name: '../../etc/passwd  weird? name.md', content: 'safe' });
    // The basename can't contain `/` or `?` after sanitization.
    const finalName = path.basename(saved.absPath);
    expect(finalName).not.toMatch(/[\/\?]/);
    expect(finalName).toMatch(/_zzzzz\.md$/);
    // And it landed inside the project's attachments folder, not anywhere else.
    expect(saved.absPath.startsWith(path.join(cwd, '.continuum', 'Attachment') + path.sep)).toBe(true);
  });
});
