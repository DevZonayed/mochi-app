/* Mobile M08 — Budget & Live Meters. */

function HeroRing() {
  const pct = 38.2 / 200, R = 88, C = 2 * Math.PI * R;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 0 18px' }}>
      <div style={{ position: 'relative', width: 220, height: 220 }}>
        <svg width="220" height="220" viewBox="0 0 220 220" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx="110" cy="110" r={R} fill="none" stroke="var(--fill-secondary)" strokeWidth="16" />
          <circle className="ring-sweep" cx="110" cy="110" r={R} fill="none" stroke="var(--blue)" strokeWidth="16" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ font: '700 44px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>$38.20</span>
          <span style={{ font: '500 15px/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 6 }}>of $200</span>
        </div>
      </div>
      <div style={{ font: '500 14px/1 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 8 }}>≈ $96 by Jun 30</div>
    </div>
  );
}

const M_CAPS = [
  { proj: 'atlas', spent: 14.2, cap: 50 }, { proj: 'content', spent: 9.1, cap: 30 },
  { proj: 'scan', spent: 30, cap: 30, paused: true }, { proj: 'brand', spent: 3.9, cap: 40 },
];
const M_LEDGER = [['14:02', 'Opus tokens · build pass', '0.43'], ['13:40', 'Video render · 24s', '28.80'], ['11:15', 'Search · 120 queries', '0.48'], ['09:30', 'Image gen · 48 @3x', '1.92']];

function Budget() {
  const [theme] = useTheme('light');
  const spark = [12, 18, 9, 22, 30, 16, 24, 28, 20, 34, 26, 31]; const mx = Math.max(...spark);
  return (
    <PhoneFrame>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 16px 4px' }}>
        <a href="../home/Home.html" style={{ color: 'var(--blue)' }}><Icon name="arrowLeft" size={22} /></a>
      </div>
      <LargeTitle title="Budget" />
      {/* live expensive run pin */}
      <div style={{ margin: '0 16px 16px', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 14, background: 'rgba(255,149,0,0.1)', border: '0.5px solid rgba(255,149,0,0.3)' }}>
        <Spinner size={16} color="var(--orange)" />
        <span style={{ flex: 1, font: '600 14px/1.2 var(--font-text)', color: 'var(--ink)' }}>Rendering · <span style={{ fontFamily: 'var(--font-mono)' }}>$3.40</span> and counting</span>
        <span style={{ font: '600 14px/1 var(--font-text)', color: 'var(--red)' }}>Cancel</span>
      </div>

      <HeroRing />

      {/* today strip */}
      <div style={{ margin: '0 16px 20px', padding: 16, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}><span style={{ font: '600 13px/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Today</span><span style={{ font: '700 15px/1 var(--font-mono)', color: 'var(--ink)' }}>$6.40</span></div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 44 }}>{spark.map((v, i) => <div key={i} style={{ flex: 1, height: `${v / mx * 100}%`, borderRadius: 2, background: i === spark.length - 1 ? 'var(--blue)' : 'color-mix(in srgb, var(--blue) 35%, transparent)' }} />)}</div>
      </div>

      {/* per-project caps */}
      <MGroup header="Per-project caps">
        {M_CAPS.map((c, i) => { const pct = Math.min(1, c.spent / c.cap); const col = pct >= 1 ? 'var(--red)' : pct >= 0.75 ? 'var(--orange)' : M_PROJ[c.proj].color; return (
          <MRow key={i} last={i === M_CAPS.length - 1}>
            <span style={{ width: 9, height: 9, borderRadius: 5, background: M_PROJ[c.proj].color, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
                <span style={{ font: '500 15px/1 var(--font-text)', color: 'var(--ink)' }}>{M_PROJ[c.proj].name}</span>
                {c.paused ? <span style={{ height: 18, padding: '0 7px', borderRadius: 9, background: 'rgba(255,59,48,0.14)', color: 'var(--red)', font: '600 11px/18px var(--font-text)' }}>Paused</span> : null}
              </span>
              <span style={{ display: 'block', height: 5, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                <span style={{ display: 'block', width: (pct * 100) + '%', height: '100%', borderRadius: 3, background: col }} />
              </span>
            </span>
            <span style={{ font: '500 13px/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{'$' + c.spent.toFixed(2) + ' / $' + c.cap}</span>
          </MRow>
        ); })}
      </MGroup>

      {/* savings */}
      <div style={{ margin: '20px 16px', padding: 16, borderRadius: 14, background: 'linear-gradient(135deg, color-mix(in srgb, var(--green) 12%, var(--bg-elevated)), var(--bg-elevated))', border: '0.5px solid rgba(52,199,89,0.3)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, background: 'var(--green)', color: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="enter" size={18} style={{ transform: 'rotate(90deg)' }} /></span>
        <span style={{ font: '500 15px/1.4 var(--font-text)', color: 'var(--ink)' }}>Caching &amp; batch saved <b style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>$41.07</b> this month</span>
      </div>

      {/* ledger */}
      <MGroup header="Today's ledger" footer={<a href="#" style={{ color: 'var(--blue)', textDecoration: 'none' }}>View all on Mac →</a>} style={{ marginBottom: 24 }}>
        {M_LEDGER.map((r, i) => (
          <MRow key={i} last={i === M_LEDGER.length - 1}>
            <span style={{ font: '500 13px/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 44, flexShrink: 0 }}>{r[0]}</span>
            <span style={{ flex: 1, font: '400 14px/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r[1]}</span>
            <span style={{ font: '600 14px/1 var(--font-mono)', color: 'var(--ink)' }}>${r[2]}</span>
          </MRow>
        ))}
      </MGroup>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Budget />);
