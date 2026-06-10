/* Budget & Cost Governance — hero stats, caps, breakdown, savings, ledger, rules. */

function Ring({ pct, size = 120, stroke = 11, color }) {
  const r = size / 2 - stroke / 2, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-secondary)" strokeWidth={stroke} />
      <circle className="ring-sweep" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
    </svg>
  );
}

function HeroBand() {
  const ringColor = p => p >= 0.9 ? 'var(--red)' : p >= 0.75 ? 'var(--orange)' : 'var(--blue)';
  const spark = [12, 18, 9, 22, 30, 16, 24, 28, 20, 34, 26, 31];
  const maxS = Math.max(...spark);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18, marginBottom: 26 }}>
      {/* this month */}
      <GlassStat>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
            <Ring pct={38.2 / 200} color={ringColor(38.2 / 200)} />
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>19%</span>
            </div>
          </div>
          <div>
            <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>This month</div>
            <div className="count-num" style={{ font: '700 40px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>$38.20</div>
            <div style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 8 }}>of $200 ceiling</div>
          </div>
        </div>
      </GlassStat>
      {/* today */}
      <GlassStat>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>Today</div>
        <div className="count-num" style={{ font: '700 40px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>$6.40</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 44, marginTop: 16 }}>
          {spark.map((v, i) => <div key={i} style={{ flex: 1, height: `${(v / maxS) * 100}%`, borderRadius: 2, background: i === spark.length - 1 ? 'var(--blue)' : 'color-mix(in srgb, var(--blue) 35%, transparent)' }} />)}
        </div>
        <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 6 }}>by hour · last 12h</div>
      </GlassStat>
      {/* projected */}
      <GlassStat>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>Projected</div>
        <div className="count-num" style={{ font: '700 40px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>≈ $96</div>
        <div style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 8 }}>by Jun 30</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
          <Icon name="check" size={12} stroke={2.6} /> Comfortably under ceiling
        </div>
      </GlassStat>
    </div>
  );
}
function GlassStat({ children }) {
  return <div style={{ background: 'var(--bg-grouped)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>{children}</div>;
}

const CAPS = [
  { name: 'Atlas API', tint: 'var(--blue)', spent: 18.4, cap: 50 },
  { name: 'Q3 Content', tint: 'var(--purple)', spent: 9.1, cap: 30 },
  { name: 'Market Scan', tint: 'var(--indigo)', spent: 30.0, cap: 30, capped: true },
  { name: 'Brand Refresh', tint: 'var(--teal)', spent: 3.9, cap: 40 },
  { name: 'Infra / CI', tint: 'var(--orange)', spent: 5.2, cap: 25 },
];
function CapsList({ onEdit }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: '8px 18px' }}>
      {CAPS.map((c, i) => {
        const pct = Math.min(1, c.spent / c.cap);
        const col = pct >= 1 ? 'var(--red)' : pct >= 0.75 ? 'var(--orange)' : c.tint;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: i < CAPS.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ width: 110, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: c.tint }} />
              <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
            </span>
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
              <div style={{ width: `${pct * 100}%`, height: '100%', borderRadius: 4, background: col }} />
            </div>
            {c.capped && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)', flexShrink: 0 }}><Icon name="lock" size={11} /> Paused at cap</span>}
            <button onClick={() => onEdit(c)} className="cap-edit" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)', padding: '4px 8px', borderRadius: 7 }}>
              <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>
              <span style={{ color: 'var(--ink-secondary)' }}>${c.spent.toFixed(0)}</span> / ${c.cap}</span> <Icon name="sliders" size={13} style={{ color: 'var(--ink-tertiary)' }} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

const BREAKDOWN = [
  { label: 'Models', tint: 'var(--blue)', v: 14.2 }, { label: 'Video', tint: 'var(--teal)', v: 9.8 },
  { label: 'Images', tint: 'var(--purple)', v: 4.1 }, { label: 'Voice/Avatar', tint: 'var(--indigo)', v: 3.6 },
  { label: 'Search', tint: 'var(--orange)', v: 2.9 }, { label: 'Renders', tint: 'var(--green)', v: 2.2 }, { label: 'Publishing', tint: 'var(--red)', v: 1.4 },
];
function Breakdown() {
  const total = BREAKDOWN.reduce((a, b) => a + b.v, 0);
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)', flex: 1 }}>Cost breakdown</span>
        {['By project', 'By category', 'By model role'].map((t, i) => (
          <button key={i} style={{ height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)', font: '600 var(--fs-caption)/1 var(--font-text)', background: i === 1 ? 'var(--blue)' : 'var(--fill-secondary)', color: i === 1 ? '#fff' : 'var(--ink-secondary)' }}>{t}</button>
        ))}
      </div>
      {/* stacked bar */}
      <div style={{ display: 'flex', height: 28, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
        {BREAKDOWN.map((b, i) => <div key={i} title={b.label} style={{ width: `${(b.v / total) * 100}%`, background: b.tint }} />)}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
        {BREAKDOWN.map((b, i) => (
          <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: b.tint }} />
            <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{b.label}</span>
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${b.v.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SavingsCard() {
  return (
    <div style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--green) 12%, var(--bg-elevated)), var(--bg-elevated))', borderRadius: 16, border: '0.5px solid rgba(52,199,89,0.3)', boxShadow: 'var(--card-shadow)', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--green)', color: '#fff', flexShrink: 0 }}><Icon name="enter" size={20} style={{ transform: 'rotate(90deg)' }} /></span>
        <div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Caching &amp; batch saved</div>
          <div className="count-num" style={{ font: '700 var(--fs-title1)/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--green)' }}>$41.07</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>this month</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
        {[['Cache hits', '90% off', '$28.40'], ['Batch processing', '−50%', '$12.67']].map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="check" size={14} stroke={2.6} style={{ color: 'var(--green)' }} />
            <span style={{ flex: 1, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{r[0]} <span style={{ color: 'var(--ink-tertiary)' }}>· {r[1]}</span></span>
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{r[2]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const BG_LEDGER = [
  { time: '14:02', proj: 'Atlas API', job: 'Refactor auth', item: 'Opus tokens · build pass', qty: '48.2k', unit: '$0.009/1k', total: '0.43' },
  { time: '13:40', proj: 'Q3 Content', job: 'Launch film', item: 'Video render · 24s', unit: '$1.20/s', qty: '24s', total: '28.80' },
  { time: '11:15', proj: 'Market Scan', job: 'Competitor digest', item: 'Search API · queries', qty: '120', unit: '$0.004', total: '0.48' },
  { time: '09:30', proj: 'Brand Refresh', job: 'OG images', item: 'Image gen · @3x', qty: '48', unit: '$0.04', total: '1.92' },
  { time: 'Yest', proj: 'Atlas API', job: 'Nightly tests', item: 'Haiku tokens · CI', qty: '210k', unit: '$0.001/1k', total: '0.21' },
];
function BgLedger() {
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '70px 1.3fr 1.5fr 0.8fr 1fr 0.8fr', gap: 14, padding: '11px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {['Time', 'Project ▸ Job', 'Item', 'Qty', 'Unit', 'Total'].map((h, i) => <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', textAlign: i === 5 ? 'right' : 'left' }}>{h}</span>)}
      </div>
      {BG_LEDGER.map((r, i) => (
        <div key={i} className="led-row" style={{ display: 'grid', gridTemplateColumns: '70px 1.3fr 1.5fr 0.8fr 1fr 0.8fr', gap: 14, alignItems: 'center', padding: '12px 18px', borderBottom: i < BG_LEDGER.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer' }}>
          <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{r.time}</span>
          <span style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><b style={{ fontWeight: 600 }}>{r.proj}</b> <span style={{ color: 'var(--ink-tertiary)' }}>▸ {r.job}</span></span>
          <span style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.item}</span>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{r.qty}</span>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{r.unit}</span>
          <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', textAlign: 'right' }}>${r.total}</span>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { Ring, HeroBand, CapsList, CAPS, Breakdown, SavingsCard, BgLedger });
