/* Mobile M10 — Notifications (in-app list + push comps). */

const NOTIFS = {
  Today: [
    { icon: 'enter', tint: 'var(--orange)', msg: 'PsychGate needs approval — plan ready', proj: 'Atlas API', t: '2m', unread: true },
    { icon: 'checkCircle', tint: 'var(--green)', msg: 'Build finished · $1.12 · 14 min', proj: 'Atlas API', t: '20m', unread: true },
    { icon: 'send', tint: 'var(--teal)', msg: 'Published video to YouTube', proj: 'Q3 Content', t: '1h' },
    { icon: 'gauge', tint: 'var(--orange)', msg: 'Market Scan at 90% of cap', proj: 'Market Scan', t: '2h' },
  ],
  Yesterday: [
    { icon: 'xCircle', tint: 'var(--red)', msg: 'Job failed — render timeout', proj: 'Brand Refresh', t: '18h' },
    { icon: 'shield', tint: 'var(--indigo)', msg: 'Skill quarantined: figma-export', proj: 'Workspace', t: '21h' },
    { icon: 'clock', tint: 'var(--blue)', msg: 'Nightly test suite fired', proj: 'Atlas API', t: '1d' },
  ],
};

function Notifications() {
  const [theme] = useTheme('light');
  const [tab, setTab] = React.useState('inapp');
  return (
    <PhoneFrame>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 16px 4px' }}>
        <a href="../home/Home.html" style={{ color: 'var(--blue)' }}><Icon name="arrowLeft" size={22} /></a>
      </div>
      <LargeTitle title="Activity" trailing={<button style={{ font: '500 15px/1 var(--font-text)', color: 'var(--blue)' }}>Mark all read</button>} />
      {/* toggle in-app vs push comps */}
      <div style={{ display: 'flex', gap: 6, padding: '4px 16px 16px' }}>
        {[['inapp', 'In-app'], ['push', 'Push designs']].map(t => <button key={t[0]} onClick={() => setTab(t[0])} style={{ height: 30, padding: '0 14px', borderRadius: 15, font: '600 13px/1 var(--font-text)', background: tab === t[0] ? 'var(--blue)' : 'var(--fill-secondary)', color: tab === t[0] ? '#fff' : 'var(--ink-secondary)' }}>{t[1]}</button>)}
      </div>

      {tab === 'inapp' ? Object.entries(NOTIFS).map(([day, rows]) => (
        <div key={day} style={{ marginBottom: 12 }}>
          <div style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)', padding: '4px 20px 8px' }}>{day}</div>
          <div style={{ margin: '0 16px', background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 15px', borderBottom: i < rows.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${r.tint} 14%, transparent)`, color: r.tint }}><Icon name={r.icon} size={18} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', font: `${r.unread ? 600 : 500} 15px/1.25 var(--font-text)`, color: 'var(--ink)' }}>{r.msg}</span>
                  <span style={{ display: 'block', font: '400 12px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{r.proj} · {r.t}</span>
                </span>
                {r.unread && <span style={{ width: 9, height: 9, borderRadius: 5, background: 'var(--blue)', flexShrink: 0 }} />}
              </div>
            ))}
          </div>
        </div>
      )) : (
        <div style={{ padding: '0 20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* lock-screen push */}
          <div>
            <div style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Lock screen · gate</div>
            <div style={{ borderRadius: 18, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: 11, padding: 14 }}>
                <span style={{ width: 36, height: 36, borderRadius: 9, background: 'color-mix(in srgb, var(--orange) 14%, transparent)', color: 'var(--orange)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="enter" size={18} /></span>
                <div style={{ flex: 1 }}><div style={{ font: '600 15px/1.2 var(--font-text)', color: 'var(--ink)' }}>PsychGate needs approval</div><div style={{ font: '400 13px/1.35 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>Plan ready: migrate auth to NestJS guards · ≈ $0.60</div></div>
                <span style={{ font: '400 12px/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>now</span>
              </div>
              <div style={{ display: 'flex', borderTop: '0.5px solid var(--separator)' }}>
                <button style={{ flex: 1, padding: '12px 0', font: '600 15px/1 var(--font-text)', color: 'var(--blue)', borderRight: '0.5px solid var(--separator)' }}>Approve</button>
                <button style={{ flex: 1, padding: '12px 0', font: '500 15px/1 var(--font-text)', color: 'var(--ink-secondary)' }}>View</button>
              </div>
            </div>
          </div>
          {/* stacked thread */}
          <div>
            <div style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Stacked · per project</div>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', top: 10, left: 12, right: 12, height: 30, borderRadius: 16, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', opacity: 0.6 }} />
              <div style={{ position: 'absolute', top: 5, left: 6, right: 6, height: 40, borderRadius: 16, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', opacity: 0.8 }} />
              <div style={{ position: 'relative', display: 'flex', gap: 11, padding: 14, borderRadius: 16, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
                <MaestroMark size={32} />
                <div style={{ flex: 1 }}><div style={{ font: '600 14px/1.2 var(--font-text)', color: 'var(--ink)' }}>Atlas API · 3 notifications</div><div style={{ font: '400 13px/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>Build finished, gate raised, tests passed</div></div>
              </div>
            </div>
          </div>
          {/* live activity */}
          <div>
            <div style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Live Activity</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderRadius: 20, background: '#000', color: '#fff' }}>
              <span className="breathe" style={{ width: 9, height: 9, borderRadius: 5, background: 'var(--purple)', flexShrink: 0 }} />
              <span style={{ flex: 1, font: '600 14px/1.2 var(--font-text)' }}>Refactor auth · Building</span>
              <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}><span style={{ display: 'block', width: '64%', height: '100%', background: 'var(--blue)' }} /></div>
              <span style={{ font: '600 14px/1 var(--font-mono)' }}>$0.84</span>
            </div>
          </div>
        </div>
      )}
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Notifications />);
