/* Generates build/icon.png (1024²) with zero dependencies — a dark squircle
   with an "equalizer" mark (Maestro = orchestration), in the app's accent
   palette. electron-builder turns this single PNG into .icns/.ico at build.
   Re-run after tweaks:  node apps/desktop/build/make-icon.mjs  */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const S = 1024;
const buf = Buffer.alloc(S * S * 4); // RGBA, fully transparent

/** Alpha-over composite a colour onto pixel (x,y). */
function px(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const sa = a / 255, ba = buf[i + 3] / 255;
  const oa = sa + ba * (1 - sa);
  if (oa <= 0) return;
  buf[i] = Math.round((r * sa + buf[i] * ba * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * ba * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * ba * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

/** Filled rounded rectangle with 1px anti-aliased corners. */
function roundRect(x0, y0, w, h, rad, [r, g, b, a = 255]) {
  const x1 = x0 + w, y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      let dx = 0, dy = 0;
      if (x < x0 + rad) dx = x0 + rad - x; else if (x > x1 - rad) dx = x - (x1 - rad);
      if (y < y0 + rad) dy = y0 + rad - y; else if (y > y1 - rad) dy = y - (y1 - rad);
      const d = Math.hypot(dx, dy);
      if (d > rad) continue;
      px(x, y, r, g, b, Math.round(a * (d > rad - 1 ? rad - d : 1)));
    }
  }
}

// Background squircle (deep navy) + a soft top highlight.
const M = 84;
roundRect(M, M, S - 2 * M, S - 2 * M, 224, [11, 13, 24, 255]);
roundRect(M, M, S - 2 * M, (S - 2 * M) * 0.5, 224, [255, 255, 255, 14]);

// Equalizer bars in the accent palette (blue → indigo → purple → teal).
const bars = [
  { h: 0.42, c: [0, 122, 255] },
  { h: 0.74, c: [88, 86, 214] },
  { h: 0.56, c: [175, 82, 222] },
  { h: 0.92, c: [48, 176, 199] },
];
const innerH = S - 2 * M;
const barW = 96, gap = 40;
const totalW = bars.length * barW + (bars.length - 1) * gap;
let bx = S / 2 - totalW / 2;
const baseY = S - M - 150;
for (const b of bars) {
  const bh = innerH * b.h * 0.62;
  roundRect(bx, baseY - bh, barW, bh, barW / 2, [...b.c, 255]);
  bx += barW + gap;
}

// ── encode PNG ───────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
const stride = S * 4 + 1;
const raw = Buffer.alloc(S * stride);
for (let y = 0; y < S; y++) { raw[y * stride] = 0; buf.copy(raw, y * stride + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('./icon.png', import.meta.url), png);
console.log(`wrote build/icon.png (${png.length} bytes, ${S}×${S})`);
