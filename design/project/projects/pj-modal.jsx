/* Template Gallery — frosted modal opened by "New project". */

const GALLERY = [
  { key: 'code',     ...{} },
];

function TemplateGallery({ open, onClose }) {
  const [sel, setSel] = React.useState('code');
  React.useEffect(() => { if (open) setSel('code'); }, [open]);
  if (!open) return null;

  const items = [
    { key: 'code',     label: 'Code',     icon: 'terminal',  tint: 'var(--blue)',   blurb: 'Connect a repo. Agents build features, run tests, and open PRs behind a merge gate.' },
    { key: 'design',   label: 'Design',   icon: 'brush',     tint: 'var(--teal)',   blurb: 'Generate and export assets at scale, with brand-review gates before anything ships.' },
    { key: 'content',  label: 'Content',  icon: 'play',      tint: 'var(--purple)', blurb: 'Draft, schedule, and publish across channels — every post waits for your approval.' },
    { key: 'research', label: 'Research', icon: 'telescope', tint: 'var(--indigo)', blurb: 'Run recurring scans and digests with sourced, citation-backed summaries.' },
    { key: 'custom',   label: 'Custom',   icon: 'sliders',   tint: 'var(--ink-secondary)', blurb: 'Start blank. Pick your own tools, schedules, and approval rules.' },
  ];

  return (
    <div onMouseDown={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 720, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 20,
        border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 40px 100px rgba(10,15,40,0.5), var(--glass-inner)', overflow: 'hidden',
        animation: 'modalPop 220ms var(--spring)',
      }}>
        <div style={{ padding: '22px 24px 16px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>New project</h2>
              <p style={{ margin: '5px 0 0', font: '400 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Templates bundle the tools, schedules, and approval gates a project needs.</p>
            </div>
            <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}>
              <Icon name="x" size={18} />
            </button>
          </div>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {items.map(it => {
            const on = sel === it.key;
            return (
              <button key={it.key} onClick={() => setSel(it.key)} style={{
                textAlign: 'left', display: 'flex', gap: 12, padding: 14, borderRadius: 14,
                background: on ? `color-mix(in srgb, ${it.tint} 9%, var(--bg-elevated))` : 'var(--fill-tertiary)',
                border: `1.5px solid ${on ? it.tint : 'transparent'}`, transition: 'border-color 140ms ease, background 140ms ease',
              }}>
                <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center',
                  background: `color-mix(in srgb, ${it.tint} 16%, transparent)`, color: it.tint }}>
                  <Icon name={it.icon} size={20} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>
                    {it.label}
                    {on && <Icon name="check" size={14} stroke={3} style={{ color: it.tint }} />}
                  </span>
                  <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4, textWrap: 'pretty' }}>{it.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <span style={{ flex: 1, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            You can change tools and gates after creating.
          </span>
          <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onClose} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Create project</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TemplateGallery });
