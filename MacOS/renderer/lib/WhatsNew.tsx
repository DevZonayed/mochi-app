import React from 'react';

/* "What's New" sheet — renders a release's notes (GitHub markdown) in a modal.
   Self-contained minimal markdown so it doesn't couple to the chat renderer. */

function inline(text: string, key: string): React.ReactNode {
  // **bold**, `code`, and [label](url) → label (links aren't navigable here).
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]+\))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] != null) nodes.push(<b key={`${key}-${i++}`} style={{ fontWeight: 700 }}>{m[2]}</b>);
    else if (m[3] != null) nodes.push(<code key={`${key}-${i++}`} style={{ font: '500 0.92em var(--font-mono)', background: 'var(--fill-secondary)', padding: '1px 5px', borderRadius: 5 }}>{m[3]}</code>);
    else if (m[4] != null) nodes.push(<span key={`${key}-${i++}`} style={{ color: 'var(--blue)' }}>{m[4]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderMarkdown(md: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let list: React.ReactNode[] | null = null;
  const flush = () => { if (list) { out.push(<ul key={`ul-${out.length}`} style={{ margin: '6px 0 12px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 5 }}>{list}</ul>); list = null; } };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) { flush(); const lvl = h[1].length; out.push(<div key={idx} style={{ font: `700 ${lvl === 1 ? 'var(--fs-headline)' : 'var(--fs-callout)'}/1.3 var(--font-display)`, color: 'var(--ink)', margin: '14px 0 6px' }}>{inline(h[2], `h${idx}`)}</div>); }
    else if (li) { (list ??= []).push(<li key={idx} style={{ color: 'var(--ink)' }}>{inline(li[1], `li${idx}`)}</li>); }
    else if (!line.trim()) { flush(); }
    else { flush(); out.push(<p key={idx} style={{ margin: '0 0 10px', color: 'var(--ink)' }}>{inline(line, `p${idx}`)}</p>); }
  });
  flush();
  return out;
}

export function WhatsNew({ version, notes, onClose, onOpenReleases }: {
  version: string; notes: string; onClose: () => void; onOpenReleases?: () => void;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 220, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.42)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 540, maxWidth: '90vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 24px 14px' }}>
          <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>What's New</h2>
          <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)', background: 'var(--fill-secondary)', padding: '4px 9px', borderRadius: 'var(--r-pill)' }}>v{version}</span>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 8px', font: '400 var(--fs-callout)/1.55 var(--font-text)' }}>
          {notes.trim()
            ? renderMarkdown(notes)
            : <p style={{ color: 'var(--ink-secondary)' }}>Release notes for this version aren't available yet.</p>}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 24px 18px', borderTop: '0.5px solid var(--separator)' }}>
          {onOpenReleases && <button onClick={onOpenReleases} style={{ height: 38, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>View on GitHub</button>}
          <button onClick={onClose} style={{ height: 38, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Done</button>
        </div>
      </div>
    </div>
  );
}
