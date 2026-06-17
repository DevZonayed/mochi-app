/* File-type icons — a small, dependency-free take on VS Code's Material Icon
   Theme. Each known extension maps to a colored, rounded "tile" with a short
   brand label (JS = yellow `JS`, TS = blue `TS`, JSON = `{}`, …). Rendered two
   ways from one source of truth: an HTML string (for the contenteditable chips,
   which are built imperatively) and a React component (for the file tree).
   Unknown types fall back to a neutral tile showing the extension. */
import React from 'react';

export function fileExt(name: string): string {
  const base = (name.split(/[\\/]/).pop() || name).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return 'dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  if (base === 'package.json') return 'npm';
  if (base.startsWith('.env')) return 'env';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

export interface FileIconSpec { bg: string; fg: string; label: string }

const ICONS: Record<string, FileIconSpec> = {
  // ── JS / TS ──
  js: { bg: '#f0db4f', fg: '#3a3a00', label: 'JS' }, mjs: { bg: '#f0db4f', fg: '#3a3a00', label: 'JS' }, cjs: { bg: '#f0db4f', fg: '#3a3a00', label: 'JS' },
  jsx: { bg: '#61dafb', fg: '#08303f', label: 'JSX' }, ts: { bg: '#3178c6', fg: '#fff', label: 'TS' }, tsx: { bg: '#3178c6', fg: '#bfe0ff', label: 'TSX' },
  // ── web ──
  html: { bg: '#e34f26', fg: '#fff', label: '<>' }, htm: { bg: '#e34f26', fg: '#fff', label: '<>' },
  css: { bg: '#1572b6', fg: '#fff', label: '#' }, scss: { bg: '#cd6799', fg: '#fff', label: '#' }, sass: { bg: '#cd6799', fg: '#fff', label: '#' }, less: { bg: '#1d365d', fg: '#fff', label: '#' },
  vue: { bg: '#41b883', fg: '#0b3a26', label: 'V' }, svelte: { bg: '#ff3e00', fg: '#fff', label: 'S' }, astro: { bg: '#ff5d01', fg: '#fff', label: 'A' },
  // ── data / config ──
  json: { bg: '#cbb723', fg: '#2a2700', label: '{}' }, jsonc: { bg: '#cbb723', fg: '#2a2700', label: '{}' }, json5: { bg: '#cbb723', fg: '#2a2700', label: '{}' },
  npm: { bg: '#cb3837', fg: '#fff', label: 'NPM' },
  yaml: { bg: '#cb171e', fg: '#fff', label: 'YML' }, yml: { bg: '#cb171e', fg: '#fff', label: 'YML' }, toml: { bg: '#9c4221', fg: '#fff', label: 'TML' },
  xml: { bg: '#f1662a', fg: '#fff', label: 'XML' }, ini: { bg: '#6d6d6d', fg: '#fff', label: 'INI' }, env: { bg: '#ecd53f', fg: '#3a3500', label: 'ENV' },
  csv: { bg: '#1d6f42', fg: '#fff', label: 'CSV' }, tsv: { bg: '#1d6f42', fg: '#fff', label: 'TSV' }, sql: { bg: '#336791', fg: '#fff', label: 'SQL' },
  graphql: { bg: '#e10098', fg: '#fff', label: 'GQL' }, gql: { bg: '#e10098', fg: '#fff', label: 'GQL' }, proto: { bg: '#5a67d8', fg: '#fff', label: 'PB' },
  // ── languages ──
  py: { bg: '#3776ab', fg: '#ffe873', label: 'PY' }, go: { bg: '#00add8', fg: '#fff', label: 'GO' }, rs: { bg: '#222', fg: '#deae8e', label: 'RS' },
  rb: { bg: '#cc342d', fg: '#fff', label: 'RB' }, java: { bg: '#ea2d2e', fg: '#fff', label: 'JV' }, kt: { bg: '#7f52ff', fg: '#fff', label: 'KT' },
  php: { bg: '#777bb4', fg: '#fff', label: 'PHP' }, c: { bg: '#5577aa', fg: '#fff', label: 'C' }, h: { bg: '#5577aa', fg: '#fff', label: 'H' },
  cpp: { bg: '#00599c', fg: '#fff', label: 'C++' }, cc: { bg: '#00599c', fg: '#fff', label: 'C++' }, hpp: { bg: '#00599c', fg: '#fff', label: 'H++' },
  cs: { bg: '#178600', fg: '#fff', label: 'C#' }, swift: { bg: '#f05138', fg: '#fff', label: 'SW' }, dart: { bg: '#0175c2', fg: '#fff', label: 'DRT' },
  sh: { bg: '#4eaa25', fg: '#fff', label: 'SH' }, bash: { bg: '#4eaa25', fg: '#fff', label: 'SH' }, zsh: { bg: '#4eaa25', fg: '#fff', label: 'SH' },
  lua: { bg: '#000080', fg: '#fff', label: 'LUA' }, r: { bg: '#276dc3', fg: '#fff', label: 'R' }, ex: { bg: '#6e4a7e', fg: '#fff', label: 'EX' }, exs: { bg: '#6e4a7e', fg: '#fff', label: 'EX' },
  dockerfile: { bg: '#2496ed', fg: '#fff', label: 'DKR' }, makefile: { bg: '#6d8086', fg: '#fff', label: 'MK' },
  // ── docs ──
  md: { bg: '#519aba', fg: '#fff', label: 'MD' }, mdx: { bg: '#519aba', fg: '#fff', label: 'MDX' }, txt: { bg: '#7d7d7d', fg: '#fff', label: 'TXT' },
  pdf: { bg: '#e34f26', fg: '#fff', label: 'PDF' }, rst: { bg: '#7d7d7d', fg: '#fff', label: 'RST' },
  // ── images / media ──
  png: { bg: '#a259ff', fg: '#fff', label: 'PNG' }, jpg: { bg: '#a259ff', fg: '#fff', label: 'JPG' }, jpeg: { bg: '#a259ff', fg: '#fff', label: 'JPG' },
  gif: { bg: '#a259ff', fg: '#fff', label: 'GIF' }, webp: { bg: '#a259ff', fg: '#fff', label: 'WEB' }, ico: { bg: '#a259ff', fg: '#fff', label: 'ICO' },
  svg: { bg: '#ffb13b', fg: '#3a2a00', label: 'SVG' },
  // ── misc ──
  zip: { bg: '#b8860b', fg: '#fff', label: 'ZIP' }, tar: { bg: '#b8860b', fg: '#fff', label: 'TAR' }, gz: { bg: '#b8860b', fg: '#fff', label: 'GZ' }, lock: { bg: '#6d6d6d', fg: '#ffd343', label: 'LCK' },
};

export function fileIconSpec(name: string): FileIconSpec {
  const ext = fileExt(name);
  return ICONS[ext] ?? { bg: 'var(--fill-tertiary)', fg: 'var(--ink-secondary)', label: ext ? ext.slice(0, 4).toUpperCase() : '•' };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const fontFor = (len: number) => (len <= 2 ? 8 : len === 3 ? 6.5 : 5.5);
const tileCss = (s: FileIconSpec, px: number) =>
  `display:inline-flex;align-items:center;justify-content:center;width:${px}px;height:${px}px;border-radius:4px;background:${s.bg};color:${s.fg};font:800 ${fontFor(s.label.length)}px/1 ui-monospace,SFMono-Regular,Menlo,monospace;flex-shrink:0;letter-spacing:-0.03em;`;

/** HTML string for the icon — for the imperatively-built composer chips. */
export function fileIconHtml(name: string, px = 15): string {
  const s = fileIconSpec(name);
  return `<span style="${tileCss(s, px)}">${esc(s.label)}</span>`;
}

/** React element for the icon — for the file tree and other React surfaces. */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }) {
  const s = fileIconSpec(name);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: 4, background: s.bg, color: s.fg, font: `800 ${fontFor(s.label.length)}px/1 ui-monospace, SFMono-Regular, Menlo, monospace`, flexShrink: 0, letterSpacing: '-0.03em' }}>{s.label}</span>
  );
}
