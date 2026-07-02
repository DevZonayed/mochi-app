/* Written-file chip shared by the chat and the transcript screen: a colored
   file-type badge + filename, with a hover preview of the content the agent
   wrote (portal-rendered so no scroll parent clips it). */

import React from 'react';
import { createPortal } from 'react-dom';

/* File-type accent by extension (GitHub-ish), for the little type badge. */
const EXT_COLOR: Record<string, string> = {
  js: '#f7df1e', cjs: '#f7df1e', mjs: '#f7df1e', jsx: '#61dafb', ts: '#3178c6', tsx: '#3178c6',
  json: '#cbcb41', jsonc: '#cbcb41', py: '#3572a5', rb: '#cc342d', go: '#00add8', rs: '#dea584', php: '#777bb4',
  html: '#e34c26', htm: '#e34c26', css: '#2965f1', scss: '#c6538c', sass: '#c6538c', md: '#519aba', mdx: '#519aba',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051', yml: '#cb171e', yaml: '#cb171e', toml: '#9c4221', ini: '#6d8086',
  env: '#cbcb41', sql: '#e38c00', java: '#b07219', kt: '#a97bff', swift: '#f05138', c: '#599bd6', h: '#599bd6',
  cpp: '#f34b7d', cs: '#178600', vue: '#41b883', svelte: '#ff3e00', dart: '#00b4ab', xml: '#0060ac', svg: '#ffb13b',
  txt: '#9aa0a6', lock: '#9aa0a6', dockerfile: '#2496ed',
};

export const IS_WRITE_TOOL = (name: string): boolean => /write|edit|create|patch|notebook/i.test(name);

function baseName(p: string): string { return (p.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() || p).trim(); }

function fileBadge(base: string): { ext: string; color: string } {
  const lower = base.toLowerCase();
  let ext = lower.endsWith('.d.ts') ? 'ts' : (lower.includes('.') ? lower.split('.').pop()! : '');
  if (!ext && lower.includes('dockerfile')) ext = 'dockerfile';
  return { ext: (ext || 'file').slice(0, 4), color: EXT_COLOR[ext] || 'var(--ink-tertiary)' };
}

function FileBadge({ ext, color }: { ext: string; color: string }) {
  return (
    <span style={{ flexShrink: 0, minWidth: 18, height: 16, padding: '0 4px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: `color-mix(in srgb, ${color} 22%, transparent)`, color, font: '700 9px/1 var(--font-mono)', letterSpacing: '0.02em' }}>{ext}</span>
  );
}

export function FileChip({ path, preview }: { path: string; preview?: string }) {
  const base = baseName(path);
  const { ext, color } = fileBadge(base);
  const ref = React.useRef<HTMLSpanElement>(null);
  const [pop, setPop] = React.useState<{ left: number; top: number; above: boolean } | null>(null);
  const show = () => {
    const el = ref.current; if (!el || preview == null) return;
    const r = el.getBoundingClientRect();
    const above = r.bottom + 360 > window.innerHeight && r.top > 360;
    setPop({ left: Math.max(12, Math.min(r.left, window.innerWidth - 480)), top: above ? r.top - 8 : r.bottom + 8, above });
  };
  const lines = preview != null ? preview.split('\n') : [];
  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={() => setPop(null)} title={path}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
      <FileBadge ext={ext} color={color} />
      <span style={{ minWidth: 0, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{base}</span>
      {pop && preview != null && createPortal(
        <div style={{ position: 'fixed', left: pop.left, ...(pop.above ? { bottom: window.innerHeight - pop.top } : { top: pop.top }), zIndex: 300, width: 460, maxWidth: 'calc(100vw - 24px)',
          background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--glass-border)', boxShadow: '0 18px 50px rgba(10,15,40,0.4)', overflow: 'hidden', pointerEvents: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
            <FileBadge ext={ext} color={color} />
            <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{base}</span>
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
          </div>
          <div style={{ maxHeight: 320, overflow: 'hidden', display: 'flex', font: '400 12px/1.55 var(--font-mono)' }}>
            <div aria-hidden style={{ flexShrink: 0, padding: '10px 8px 10px 12px', textAlign: 'right', color: 'var(--ink-tertiary)', opacity: 0.6, userSelect: 'none', background: 'var(--bg-grouped)' }}>
              {lines.slice(0, 200).map((_, i) => <div key={i}>{i + 1}</div>)}
            </div>
            <pre style={{ margin: 0, padding: '10px 14px', whiteSpace: 'pre', color: 'var(--ink)', flex: 1, minWidth: 0 }}>{lines.slice(0, 200).join('\n')}</pre>
          </div>
        </div>, document.body)}
    </span>
  );
}
