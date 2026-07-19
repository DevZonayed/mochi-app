/* Binary sniffing + extension→MIME for the file-read arm. A sample (the first few
   KB of a file) is classified as binary when it contains a NUL byte, matches a known
   binary magic signature, or carries a high ratio of disallowed control / invalid-
   UTF-8 bytes. Real MP4/PDF samples (which may contain NO NUL) must read as binary;
   UTF-8 text — including multibyte emoji, source, JSON, and markdown — must not. */

import nodePath from 'node:path';

/** Fraction of disallowed control / invalid-UTF-8 bytes above which a NUL-free,
    magic-free sample is treated as binary. */
const CONTROL_RATIO_THRESHOLD = 0.1;

/** Does `buf` start with `sig` at `offset`? */
const startsWith = (buf: Buffer, sig: number[], offset = 0): boolean => {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[offset + i] !== sig[i]) return false;
  return true;
};

const asc = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** Known binary magic signatures ({ sig, offset }). Text formats are deliberately absent. */
const MAGICS: Array<{ sig: number[]; offset?: number }> = [
  { sig: asc('%PDF') },                                  // PDF
  { sig: asc('ftyp'), offset: 4 },                       // MP4 / M4V / MOV / M4A (ISO-BMFF)
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // PNG
  { sig: [0xff, 0xd8, 0xff] },                           // JPEG
  { sig: asc('GIF8') },                                  // GIF
  { sig: asc('RIFF') },                                  // RIFF (WEBP / WAV / AVI)
  { sig: asc('OggS') },                                  // OGG
  { sig: asc('ID3') },                                   // MP3 (ID3v2)
  { sig: asc('fLaC') },                                  // FLAC
  { sig: asc('PK') },                                    // ZIP / docx / jar / etc.
  { sig: [0xca, 0xfe, 0xba, 0xbe] },                     // Java class / Mach-O fat
  { sig: [0x00, 0x61, 0x73, 0x6d] },                     // WebAssembly
  { sig: [0x1f, 0x8b] },                                 // gzip
  { sig: [0x42, 0x5a, 0x68] },                           // bzip2 (BZh)
  { sig: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] },         // xz
  { sig: [0x25, 0x21, 0x50, 0x53] },                     // PostScript (%!PS)
];

/** MP3 frame-sync heuristic: 0xFF followed by a byte whose top 3 bits are set. */
const isMp3FrameSync = (buf: Buffer): boolean => buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;

/** Ratio of disallowed control bytes + invalid UTF-8 units in the sample. Walks
    UTF-8 sequences so multibyte text (accents, emoji) is NOT penalized; a sequence
    truncated at the sample boundary is ignored rather than counted as invalid. */
function suspiciousRatio(buf: Buffer): number {
  const n = buf.length;
  if (n === 0) return 0;
  let suspicious = 0;
  let i = 0;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) {
      // Tab, newline, carriage return are allowed whitespace; everything else < 0x20 plus DEL is control.
      if (b !== 0x09 && b !== 0x0a && b !== 0x0d && (b < 0x20 || b === 0x7f)) suspicious++;
      i++;
      continue;
    }
    // Multibyte lead byte → determine expected length.
    let len = 0;
    if ((b & 0xe0) === 0xc0) len = 2;
    else if ((b & 0xf0) === 0xe0) len = 3;
    else if ((b & 0xf8) === 0xf0) len = 4;
    else { suspicious++; i++; continue; } // invalid lead or lone continuation byte
    if (i + len > n) break; // truncated at the sample boundary — stop, don't penalize
    let ok = true;
    for (let j = 1; j < len; j++) if ((buf[i + j] & 0xc0) !== 0x80) { ok = false; break; }
    if (ok) i += len;
    else { suspicious++; i++; }
  }
  return suspicious / n;
}

/**
 * True when `buf` (a leading sample of a file) looks binary: a NUL byte, a known
 * binary magic signature, or a high ratio of disallowed control / invalid-UTF-8
 * bytes. Returns false for UTF-8 text including multibyte content.
 */
export function isBinarySample(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (buf.includes(0x00)) return true;
  for (const m of MAGICS) if (startsWith(buf, m.sig, m.offset ?? 0)) return true;
  if (isMp3FrameSync(buf)) return true;
  return suspiciousRatio(buf) > CONTROL_RATIO_THRESHOLD;
}

/* ── extension → MIME ─────────────────────────────────────────────────────── */
const MIME: Record<string, string> = {
  // video
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
  // documents / images
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  // text / source
  ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript',
  mjs: 'text/javascript', cjs: 'text/javascript',
  json: 'application/json', md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain',
  css: 'text/css', html: 'text/html', htm: 'text/html', xml: 'text/xml',
  yaml: 'text/yaml', yml: 'text/yaml', csv: 'text/csv', toml: 'text/plain', ini: 'text/plain',
  sh: 'text/x-shellscript', py: 'text/x-python', rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust',
};

/** Map a path's extension to a MIME type; unknown extensions → `application/octet-stream`. */
export function mimeForPath(p: string): string {
  const ext = nodePath.extname(String(p ?? '')).slice(1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}
