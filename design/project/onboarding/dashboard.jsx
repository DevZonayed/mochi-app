/* A glimpse of the Command Center dashboard that resolves behind the
   dissolving setup card on the final step. Not a full page — just enough
   to feel real through the blur. */

function DashboardPeek({ workspace, budget }) {
  const nav = [
    { icon: 'bolt', label: 'Command Center', active: true },
    { icon: 'folder', label: 'Projects' },
    { icon: 'cpu', label: 'Job monitor' },
    { icon: 'shield', label: 'Approvals' },
    { icon: 'image', label: 'Media studio' },
    { icon: 'gauge', label: 'Budget' },
  ];
  const jobs = [
    { name: 'Refactor auth service', state: 'Building', tint: 'var(--purple)', pct: 64, cost: '$0.42' },
    { name: 'Draft launch thread', state: 'Reviewing', tint: 'var(--teal)', pct: 88, cost: '$0.12' },
    { name: 'Weekly trend digest', state: 'Waiting for you', tint: 'var(--orange)', pct: 100, cost: '$0.07' },
  ];
  const spent = Math.min(budget * 0.34, budget);
  const ring = 2 * Math.PI * 26;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'var(--bg)' }}>
      {/* sidebar */}
      <div style={{
        width: 220, flexShrink: 0, padding: '52px 12px 16px',
        background: 'var(--bg-grouped)', backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
        borderRight: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', gap: 2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 8px 16px' }}>
          <MaestroMark size={26} />
          <span style={{ font: '700 15px/1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Maestro</span>
        </div>
        {nav.map(n => (
          <div key={n.label} style={{
            display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 10px', borderRadius: 8,
            background: n.active ? 'var(--blue)' : 'transparent',
            color: n.active ? '#fff' : 'var(--ink-secondary)',
            font: '500 var(--fs-subhead)/1 var(--font-text)',
          }}>
            <Icon name={n.icon} size={17} /> {n.label}
          </div>
        ))}
      </div>
      {/* main */}
      <div style={{ flex: 1, padding: '52px 28px 24px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 4 }}>{workspace || 'Your workspace'}</div>
            <div style={{ font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Good evening</div>
          </div>
          <EffortDial value="DEEP" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Live jobs</div>
            {jobs.map(j => (
              <div key={j.name} style={{
                background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
                padding: 14, boxShadow: 'var(--card-shadow)', display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ width: 9, height: 9, borderRadius: 5, background: j.tint, flexShrink: 0, boxShadow: `0 0 0 4px color-mix(in srgb, ${j.tint} 18%, transparent)` }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{j.name}</div>
                  <div style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: j.tint, marginTop: 3 }}>{j.state}</div>
                </div>
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{j.cost}</span>
              </div>
            ))}
          </div>
          <div style={{
            background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
            padding: 18, boxShadow: 'var(--card-shadow)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          }}>
            <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', alignSelf: 'flex-start' }}>This month</div>
            <svg width="120" height="120" viewBox="0 0 64 64" style={{ transform: 'rotate(-90deg)', margin: '4px 0' }}>
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--fill-secondary)" strokeWidth="7" />
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--green)" strokeWidth="7" strokeLinecap="round"
                strokeDasharray={ring} strokeDashoffset={ring * (1 - spent / budget)} />
            </svg>
            <div style={{ font: '600 var(--fs-title2)/1 var(--font-mono)', color: 'var(--ink)' }}>${spent.toFixed(0)}</div>
            <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>of ${budget} cap</div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { DashboardPeek });
