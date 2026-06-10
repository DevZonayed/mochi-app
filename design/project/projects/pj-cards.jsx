/* Projects Overview — data, template defs, cards, list rows, segmented control. */

const TEMPLATES = {
  code:     { label: 'Code',     icon: 'terminal',  tint: 'var(--blue)',   blurb: 'Repos, build & test jobs, PR review gates.' },
  design:   { label: 'Design',   icon: 'brush',     tint: 'var(--teal)',   blurb: 'Asset generation, exports, brand reviews.' },
  content:  { label: 'Content',  icon: 'play',      tint: 'var(--purple)', blurb: 'Drafts, scheduling, publish approvals.' },
  research: { label: 'Research', icon: 'telescope', tint: 'var(--indigo)', blurb: 'Scans, digests, sourced summaries.' },
};

const SEED = [
  { id: 'p1', name: 'Atlas API',        tpl: 'code',     jobs: 2, gates: 1, spent: 18.40, cap: 50,  subs: 4, next: '18:00', activity: '2m ago' },
  { id: 'p2', name: 'Q3 Content',       tpl: 'content',  jobs: 0, gates: 1, spent: 9.10,  cap: 30,  subs: 3, next: '14:00', activity: '9m ago' },
  { id: 'p3', name: 'Brand Refresh',    tpl: 'design',   jobs: 1, gates: 0, spent: 3.90,  cap: 40,  subs: 2, next: '21:00', activity: '12m ago' },
  { id: 'p4', name: 'Competitor Watch', tpl: 'research', jobs: 1, gates: 0, spent: 27.90, cap: 30,  subs: 1, next: '06:00', activity: '4m ago' },
  { id: 'p5', name: 'iOS Rewrite',      tpl: 'code',     jobs: 0, gates: 0, spent: 31.50, cap: 80,  subs: 6, next: '23:00', activity: '1h ago' },
  { id: 'p6', name: 'Ad Variations',    tpl: 'design',   jobs: 0, gates: 0, spent: 45.00, cap: 45,  subs: 2, next: '—',     activity: '3h ago', paused: true },
  { id: 'p7', name: 'Market Scan',      tpl: 'research', jobs: 1, gates: 1, spent: 22.50, cap: 60,  subs: 2, next: '16:30', activity: '6m ago' },
  { id: 'p8', name: 'Support Triage',   tpl: 'content',  jobs: 0, gates: 0, spent: 0,     cap: 25,  subs: 0, next: '—',     activity: 'Idle' },
];

function health(spent, cap) {
  const pct = cap ? spent / cap : 0;
  return pct >= 0.9 ? 'var(--red)' : pct >= 0.75 ? 'var(--orange)' : 'var(--blue)';
}

function StatusLine({ p }) {
  if (p.paused) return <span style={{ font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--red)' }}>Paused</span>;
  if (!p.jobs && !p.gates) return <span style={{ font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Idle</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
      {p.jobs > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--purple)', color: 'var(--purple)' }} />
          {`${p.jobs} ${p.jobs > 1 ? 'jobs' : 'job'} running`}
        </span>
      )}
      {p.gates > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--orange)' }} />
          {`${p.gates} ${p.gates > 1 ? 'gates' : 'gate'} waiting`}
        </span>
      )}
    </span>
  );
}

function ProjectCard({ p, onMenu, onOpen }) {
  const t = TEMPLATES[p.tpl];
  const hc = health(p.spent, p.cap);
  const pct = p.cap ? Math.min(100, (p.spent / p.cap) * 100) : 0;
  return (
    <div className="proj-card" onClick={() => onOpen && onOpen(p.id)} style={{
      position: 'relative', background: 'var(--bg-elevated)', borderRadius: 20, overflow: 'hidden',
      border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', cursor: 'pointer',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 3, background: t.tint, flexShrink: 0 }} />
      {p.paused && (
        <div style={{ position: 'absolute', top: 14, right: 14, display: 'inline-flex', alignItems: 'center', gap: 5,
          height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(255,59,48,0.14)', color: 'var(--red)',
          font: '600 var(--fs-caption)/1 var(--font-text)', zIndex: 2 }}>
          <Icon name="pause" size={11} /> Paused — budget cap
        </div>
      )}
      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        {/* top row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'grid', placeItems: 'center',
            background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
            <Icon name={t.icon} size={22} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '600 var(--fs-headline)/1.2 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{t.label}</span>
          </span>
          {!p.paused && (
            <button className="proj-menu" onClick={e => { e.stopPropagation(); onMenu(p.id); }} style={{
              width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0,
            }}><Icon name="more" size={18} /></button>
          )}
        </div>

        {/* status */}
        <StatusLine p={p} />

        {/* budget bar */}
        <div>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: hc }} />
          </div>
          <div style={{ marginTop: 7, font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
            <b style={{ color: 'var(--ink)', fontWeight: 600 }}>${p.spent.toFixed(2)}</b> / ${p.cap}
          </div>
        </div>

        {/* bottom row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto', paddingTop: 4 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 'var(--r-pill)',
            background: 'var(--fill-tertiary)', font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
            <Icon name="layers" size={12} /> {p.subs} sub
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>
            <Icon name="clock" size={12} /> {p.next === '—' ? p.activity : `Next ${p.next}`}
          </span>
        </div>
      </div>
    </div>
  );
}

function ProjectRow({ p, onMenu, onOpen, last }) {
  const t = TEMPLATES[p.tpl];
  const hc = health(p.spent, p.cap);
  const pct = p.cap ? Math.min(100, (p.spent / p.cap) * 100) : 0;
  return (
    <div className="proj-row" onClick={() => onOpen && onOpen(p.id)} style={{
      display: 'grid', gridTemplateColumns: '2fr 1.5fr 1.4fr 0.8fr 1fr 36px', alignItems: 'center', gap: 14,
      padding: '13px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
          <Icon name={t.icon} size={17} />
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
          <span style={{ display: 'block', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 1 }}>{t.label}</span>
        </span>
      </div>
      <div><StatusLine p={p} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden', maxWidth: 90 }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: hc }} />
        </div>
        <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>${p.spent.toFixed(2)}/${p.cap}</span>
      </div>
      <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{p.subs} sub</span>
      <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{p.next === '—' ? p.activity : `Next ${p.next}`}</span>
      <button className="proj-menu" onClick={e => { e.stopPropagation(); onMenu(p.id); }} style={{
        width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
        <Icon name="more" size={18} />
      </button>
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  const i = options.findIndex(o => o.key === value);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
      <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${i * 50}% + 2px)`, width: `calc(50% - 4px)`,
        background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)} style={{
          position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px',
          font: '600 var(--fs-subhead)/1 var(--font-text)', color: value === o.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>
          <Icon name={o.icon} size={15} /> {o.label}
        </button>
      ))}
    </div>
  );
}

Object.assign(window, { TEMPLATES, SEED, health, StatusLine, ProjectCard, ProjectRow, Segmented });
