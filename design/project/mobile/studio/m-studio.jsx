/* Mobile M09 — Studio Gallery (tab 4). Drafts / Rendering / Published. */

const DRAFTS = [
  { t: 'linear-gradient(150deg,#0E2A5E,#30B0C7)', ar: 9 / 16, status: 'await', dur: '0:24' },
  { t: 'linear-gradient(150deg,#2a1b4a,#5856D6)', ar: 9 / 16, status: 'draft', dur: '0:18' },
  { t: 'linear-gradient(150deg,#1b3a2a,#1F8A5B)', ar: 1, status: 'draft', dur: '0:08' },
  { t: 'linear-gradient(150deg,#3a2a1b,#FF9500)', ar: 9 / 16, status: 'await', dur: '0:32' },
  { t: 'linear-gradient(150deg,#1b2a4a,#007AFF)', ar: 9 / 16, status: 'draft', dur: '0:15' },
  { t: 'linear-gradient(150deg,#3a1b2a,#AF52DE)', ar: 1, status: 'draft', dur: '0:11' },
];

function Studio() {
  const [theme] = useTheme('light');
  const [tab, setTab] = React.useState('drafts');
  const [preview, setPreview] = React.useState(null);
  const tabs = [['drafts', 'Drafts'], ['rendering', 'Rendering'], ['published', 'Published']];
  const ti = tabs.findIndex(t => t[0] === tab);
  // 2-col masonry split
  const colA = DRAFTS.filter((_, i) => i % 2 === 0), colB = DRAFTS.filter((_, i) => i % 2 === 1);

  return (
    <PhoneFrame tabBar={<TabBar active="studio" />}>
      <LargeTitle title="Studio" />
      <div style={{ padding: '4px 16px 16px' }}>
        <div style={{ position: 'relative', display: 'flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 10 }}>
          <div style={{ position: 'absolute', top: 3, bottom: 3, left: `calc(${ti} * (100% - 6px) / 3 + 3px)`, width: `calc((100% - 6px) / 3)`, background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
          {tabs.map(t => <button key={t[0]} onClick={() => setTab(t[0])} style={{ flex: 1, position: 'relative', zIndex: 1, padding: '8px 0', font: `${tab === t[0] ? 600 : 500} 14px/1 var(--font-text)`, color: tab === t[0] ? 'var(--ink)' : 'var(--ink-secondary)' }}>{t[1]}</button>)}
        </div>
      </div>

      {tab === 'drafts' && (
        <div style={{ display: 'flex', gap: 10, padding: '0 16px 24px' }}>
          {[colA, colB].map((col, ci) => (
            <div key={ci} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {col.map((d, i) => (
                <button key={i} onClick={() => setPreview(d)} className="m-card" style={{ width: '100%', position: 'relative', borderRadius: 14, overflow: 'hidden', aspectRatio: String(d.ar), background: d.t }}>
                  <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.85)' }}><Icon name="play" size={26} /></span>
                  <span style={{ position: 'absolute', top: 8, left: 8, height: 20, padding: '0 8px', borderRadius: 10, background: d.status === 'await' ? 'rgba(255,149,0,0.9)' : 'rgba(0,0,0,0.4)', color: '#fff', font: '600 10px/20px var(--font-text)' }}>{d.status === 'await' ? 'Awaiting approval' : 'Draft'}</span>
                  <span style={{ position: 'absolute', bottom: 8, right: 8, height: 18, padding: '0 6px', borderRadius: 9, background: 'rgba(0,0,0,0.5)', color: '#fff', font: '600 10px/18px var(--font-mono)' }}>{d.dur}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {tab === 'rendering' && (
        <div style={{ padding: '0 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[['B-roll · Kling', '~90s', '3.40'], ['Avatar · hero', '~120s', '3.20']].map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }}>
              <div style={{ width: 56, height: 56, borderRadius: 12, background: 'linear-gradient(150deg,#0E2A5E,#30B0C7)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Spinner size={20} color="#fff" /></div>
              <div style={{ flex: 1 }}><div style={{ font: '600 15px/1.2 var(--font-text)', color: 'var(--ink)' }}>{r[0]}</div><div style={{ font: '400 13px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 4 }}>{r[1]} · <span style={{ fontFamily: 'var(--font-mono)' }}>${r[2]}</span></div></div>
              <span style={{ font: '600 14px/1 var(--font-text)', color: 'var(--red)' }}>Cancel</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'published' && (
        <div style={{ padding: '0 16px 24px' }}>
          <MGroup>
            {[['youtube', 'Launch film', '2h ago', '1.2k views'], ['x', 'Launch thread', 'Yesterday', '8.4k views'], ['instagram', 'Icon reveal', '2d ago', '640 views']].map((r, i, a) => (
              <MRow key={i} last={i === a.length - 1}>
                <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--fill-secondary)', display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}><Icon name={r[0] === 'youtube' ? 'play' : r[0] === 'x' ? 'send' : 'image'} size={15} /></span>
                <span style={{ flex: 1 }}><span style={{ display: 'block', font: '500 15px/1.1 var(--font-text)', color: 'var(--ink)' }}>{r[1]}</span><span style={{ display: 'block', font: '400 12px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{r[2]} · {r[3]}</span></span>
                <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} />
              </MRow>
            ))}
          </MGroup>
        </div>
      )}

      {/* full-screen preview */}
      {preview && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 60, background: '#000', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, background: preview.t, display: 'grid', placeItems: 'center', position: 'relative' }}>
            <button onClick={() => setPreview(null)} style={{ position: 'absolute', top: 54, left: 18, width: 34, height: 34, borderRadius: 17, background: 'rgba(0,0,0,0.4)', color: '#fff', display: 'grid', placeItems: 'center' }}><Icon name="chevronDown" size={20} /></button>
            <span style={{ width: 72, height: 72, borderRadius: 36, background: 'rgba(255,255,255,0.22)', backdropFilter: 'blur(6px)', display: 'grid', placeItems: 'center', color: '#fff' }}><Icon name="play" size={32} /></span>
          </div>
          <div style={{ background: 'var(--bg)', borderRadius: '16px 16px 0 0', padding: '10px 20px 30px', maxHeight: '52%', overflowY: 'auto' }} className="m-scroll">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}><span style={{ width: 36, height: 5, borderRadius: 3, background: 'var(--separator-strong)' }} /></div>
            <h2 style={{ margin: '0 0 8px', font: '700 20px/1.2 var(--font-display)', color: 'var(--ink)' }}>Launch film — vertical cut</h2>
            <p style={{ margin: '0 0 12px', font: '400 15px/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>Maestro is live. One operator, a fleet of agents.</p>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>{['YouTube', 'TikTok', 'IG'].map(p => <span key={p} style={{ height: 24, padding: '0 10px', borderRadius: 12, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 12px/24px var(--font-text)' }}>{p}</span>)}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, font: '500 13px/1 var(--font-text)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink)' }}>Cost: $7.80</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--green)' }}><Icon name="shield" size={12} /> AI label ✓ · C2PA ✓ · Consent ✓</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="m-pill" style={{ flex: 1, height: 48, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 16px/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)' }}>Approve &amp; schedule</button>
              <button style={{ width: 48, height: 48, borderRadius: 24, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', display: 'grid', placeItems: 'center' }}><Icon name="enter" size={18} style={{ transform: 'rotate(-90deg)' }} /></button>
            </div>
          </div>
        </div>
      )}
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Studio />);
