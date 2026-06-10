/* Budget & Cost Governance — 429 banner, hero stats, per-project caps,
   cost breakdown, savings card, ledger, cost rules, cap-edit sheet.
   Ported from the Babel-standalone design prototype (design/project/budget/*)
   to an ES-module TypeScript React screen. Visual output (inline styles,
   classNames, var(--…) variables, SVG geometry) is preserved exactly.
   Cross-page location.href navigation → react-router useNavigate(); shared
   chrome/primitives come from the design library. */

import React from 'react';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { GroupedList, Row, Switch } from '../lib/ui';
import { api, type BudgetData } from '../lib/api';

/* Page-specific CSS from the prototype's <style> block. Rendered as a real
   <style> element so the hover/animation classNames below keep working. */
const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .step-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 55%, var(--ink) 8%); }
  .cap-edit:hover { background: var(--fill-secondary); }
  .led-row:hover { background: var(--fill-tertiary); }
  .count-num { animation: countUp 400ms var(--spring); }
  @keyframes countUp { from { transform: translateY(-4px); } to { transform: none; } }
  .ring-sweep { animation: ringSweep 700ms var(--spring); }
  @keyframes ringSweep { from { stroke-dashoffset: 999; } }
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

// ── Ring ───────────────────────────────────────────────────────────────────
interface RingProps {
  pct: number;
  size?: number;
  stroke?: number;
  color: string;
}

function Ring({ pct, size = 120, stroke = 11, color }: RingProps) {
  const r = size / 2 - stroke / 2,
    c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fill-secondary)" strokeWidth={stroke} />
      <circle className="ring-sweep" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
    </svg>
  );
}

// ── Hero band ────────────────────────────────────────────────────────────────
function GlassStat({ children }: { children?: React.ReactNode }) {
  return <div style={{ background: 'var(--bg-grouped)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>{children}</div>;
}

function HeroBand({ cap, spent }: { cap: number; spent: number }) {
  const ringColor = (p: number) => (p >= 0.9 ? 'var(--red)' : p >= 0.75 ? 'var(--orange)' : 'var(--blue)');
  const spark = [12, 18, 9, 22, 30, 16, 24, 28, 20, 34, 26, 31];
  const maxS = Math.max(...spark);
  const pct = cap > 0 ? spent / cap : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18, marginBottom: 26 }}>
      {/* this month */}
      <GlassStat>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
            <Ring pct={pct} color={ringColor(pct)} />
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{Math.round(pct * 100)}%</span>
            </div>
          </div>
          <div>
            <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>This month</div>
            <div className="count-num" style={{ font: '700 40px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>${spent.toFixed(2)}</div>
            <div style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 8 }}>of ${cap.toFixed(0)} ceiling</div>
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

// ── Per-project caps ─────────────────────────────────────────────────────────
interface Cap {
  name: string;
  tint: string;
  spent: number;
  cap: number;
  capped?: boolean;
}

function CapsList({ caps, onEdit }: { caps: Cap[]; onEdit: (c: Cap) => void }) {
  const maxSpent = caps.reduce((m, c) => Math.max(m, c.spent), 0);
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: '8px 18px' }}>
      {caps.map((c, i) => {
        const pct = maxSpent > 0 ? Math.min(1, c.spent / maxSpent) : 0;
        const col = c.cap > 0 && c.spent >= c.cap ? 'var(--red)' : pct >= 0.75 ? 'var(--orange)' : c.tint;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: i < caps.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
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

// ── Cost breakdown ───────────────────────────────────────────────────────────
interface BreakdownItem {
  label: string;
  tint: string;
  v: number;
}

const BREAKDOWN: BreakdownItem[] = [
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

// ── Savings card ─────────────────────────────────────────────────────────────
function SavingsCard() {
  const rows: [string, string, string][] = [['Cache hits', '90% off', '$28.40'], ['Batch processing', '−50%', '$12.67']];
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
        {rows.map((r, i) => (
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

// ── Ledger ───────────────────────────────────────────────────────────────────
interface LedgerRow {
  time: string;
  proj: string;
  job: string;
  item: string;
  qty: string;
  unit: string;
  total: string;
}

const BG_LEDGER: LedgerRow[] = [
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

// ── Cost rules ───────────────────────────────────────────────────────────────
function RulesSection() {
  const [auto, setAuto] = React.useState(true);
  const [thresh, setThresh] = React.useState(85);
  return (
    <GroupedList header="Cost rules" footer="Auto-downgrade keeps jobs finishing instead of stalling at a cap.">
      <Row>
        <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}><Icon name="cpu" size={18} /></span>
        <span style={{ flex: 1 }}>
          <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Auto-downgrade near a cap</span>
          <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Switch to cheaper models automatically when close to a ceiling.</span>
        </span>
        <Switch on={auto} onChange={setAuto} />
      </Row>
      <Row>
        <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--orange) 13%, transparent)', color: 'var(--orange)' }}><Icon name="gauge" size={18} /></span>
        <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Downgrade threshold</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, background: 'var(--fill-secondary)', borderRadius: 8 }}>
          <button onClick={() => setThresh(t => Math.max(50, t - 5))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 17px/1 var(--font-text)' }}>−</button>
          <span style={{ minWidth: 46, textAlign: 'center', font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>{thresh}%</span>
          <button onClick={() => setThresh(t => Math.min(99, t + 5))} className="step-btn" style={{ width: 30, height: 30, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 17px/1 var(--font-text)' }}>+</button>
        </div>
      </Row>
      <Row last>
        <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--purple) 13%, transparent)', color: 'var(--purple)' }}><Icon name="bell" size={18} /></span>
        <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>Notify at</span>
        <span style={{ display: 'flex', gap: 6 }}>{['75%', '90%', 'Cap hit'].map((t, i) => <span key={i} style={{ height: 26, padding: '0 10px', borderRadius: 'var(--r-pill)', display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 12%, transparent)', color: 'var(--blue)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>{t}</span>)}</span>
      </Row>
    </GroupedList>
  );
}

// ── Cap-edit sheet ───────────────────────────────────────────────────────────
function CapEditSheet({ cap, onClose }: { cap: Cap; onClose: () => void }) {
  const [val, setVal] = React.useState(cap.cap);
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 32, background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 400, background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: 24 }}>
        <h2 style={{ margin: '0 0 4px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{cap.name} cap</h2>
        <p style={{ margin: '0 0 18px', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Hard monthly ceiling for this project.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 4, borderRadius: 12, border: '1.5px solid var(--blue)', marginBottom: 10 }}>
          <button onClick={() => setVal(v => Math.max(5, v - 5))} className="step-btn" style={{ width: 40, height: 40, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>−</button>
          <span style={{ flex: 1, textAlign: 'center', font: '700 var(--fs-title1)/1 var(--font-mono)', color: 'var(--ink)' }}>${val}</span>
          <button onClick={() => setVal(v => v + 5)} className="step-btn" style={{ width: 40, height: 40, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>+</button>
        </div>
        <div style={{ font: '500 var(--fs-footnote)/1.4 var(--font-mono)', color: 'var(--ink-secondary)', marginBottom: 18 }}>
          <b style={{ color: 'var(--green)', fontWeight: 600 }}>${(val - cap.spent).toFixed(2)}</b> remaining for jobs after ${cap.spent.toFixed(2)} spent.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onClose} className="primary-cta" style={{ flex: 1, height: 42, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Save cap</button>
        </div>
      </div>
    </div>
  );
}

// ── Command palette (⌘K) ─────────────────────────────────────────────────────
interface PaletteItem {
  group: string;
  icon: IconName;
  label: string;
  hint: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Actions', icon: 'play', label: 'Run job…', hint: 'Start a new job in a project' },
  { group: 'Actions', icon: 'plus', label: 'New project…', hint: 'From a template' },
  { group: 'Actions', icon: 'calendar', label: 'Schedule a run…', hint: 'Pick time & cadence' },
  { group: 'Actions', icon: 'gauge', label: 'Adjust budget cap…', hint: 'Workspace or project' },
  { group: 'Recent', icon: 'gitMerge', label: 'Merge PR #482 — auth refactor', hint: 'Atlas API' },
  { group: 'Recent', icon: 'send', label: 'Publish “Launch week” thread', hint: 'Q3 Content' },
  { group: 'Recent', icon: 'telescope', label: 'Competitor digest', hint: 'Market Scan' },
  { group: 'Jump to', icon: 'layers', label: 'Projects', hint: '⌘2' },
  { group: 'Jump to', icon: 'shield', label: 'Approvals', hint: '⌘4' },
];

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 60); }
  }, [open]);

  const filtered = PALETTE_ITEMS.filter(it => it.label.toLowerCase().includes(q.toLowerCase()) || it.hint.toLowerCase().includes(q.toLowerCase()));
  const groups = filtered.reduce<Record<string, PaletteItem[]>>((acc, it) => { (acc[it.group] = acc[it.group] || []).push(it); return acc; }, {});
  const flat = filtered;

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(flat.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Escape') { onClose(); }
    else if (e.key === 'Enter') { onClose(); }
  };

  if (!open) return null;
  let idx = -1;
  return (
    <div onMouseDown={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'center', paddingTop: 132,
      background: 'rgba(10,12,24,0.28)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 640, maxHeight: 460, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--glass-border)',
        backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 30px 80px rgba(10,15,40,0.45), var(--glass-inner)', overflow: 'hidden',
        animation: 'palettePop 200ms var(--spring)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="search" size={19} style={{ color: 'var(--ink-tertiary)' }} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="Search commands, projects, jobs…"
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent',
              font: '400 var(--fs-title2)/1 var(--font-text)', color: 'var(--ink)' }} />
          <span style={{ padding: '3px 7px', borderRadius: 5, background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>esc</span>
        </div>

        <div style={{ overflowY: 'auto', padding: 8 }}>
          {flat.length === 0 && (
            <div style={{ padding: '28px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No matches</div>
          )}
          {Object.entries(groups).map(([group, items]) => (
            <div key={group} style={{ marginBottom: 6 }}>
              <div style={{ padding: '6px 10px 4px', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{group}</div>
              {items.map(it => {
                idx++; const active = idx === sel; const myIdx = idx;
                return (
                  <div key={it.label} onMouseEnter={() => setSel(myIdx)} onMouseDown={onClose} style={{
                    display: 'flex', alignItems: 'center', gap: 11, height: 42, padding: '0 10px', borderRadius: 9, cursor: 'pointer',
                    background: active ? 'var(--blue)' : 'transparent',
                  }}>
                    <span style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0,
                      background: active ? 'rgba(255,255,255,0.2)' : 'var(--fill-secondary)', color: active ? '#fff' : 'var(--ink-secondary)' }}>
                      <Icon name={it.icon} size={16} />
                    </span>
                    <span style={{ flex: 1, font: '500 var(--fs-callout)/1.1 var(--font-text)', color: active ? '#fff' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
                    <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: active ? 'rgba(255,255,255,0.8)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{it.hint}</span>
                    {active && <Icon name="enter" size={15} style={{ color: 'rgba(255,255,255,0.9)' }} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page root ────────────────────────────────────────────────────────────────
export default function BudgetDashboard() {
  const [editCap, setEditCap] = React.useState<Cap | null>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [budget, setBudget] = React.useState<BudgetData | null>(null);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = await api.budget();
        if (alive) setBudget(b);
      } catch {
        /* fail soft — leave null, render empty/zeroed gracefully */
      }
    })();
    return () => { alive = false; };
  }, []);

  const cap = budget?.cap ?? 0;
  const spent = budget?.spent ?? 0;
  const caps: Cap[] = (budget?.byProject ?? []).map(p => ({
    name: p.name,
    tint: `var(--${p.color})`,
    spent: p.spent,
    cap,
    capped: cap > 0 && p.spent >= cap,
  }));

  return (
    <AppShell
      active="budget"
      onSearch={() => setPaletteOpen(true)}
      budget={{ spent, cap, animateKey: 0 }}
    >
      <style>{styles}</style>

      <div style={{ padding: '24px 28px 36px' }}>
        <h1 style={{ margin: '0 0 22px', font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Budget</h1>

        {/* 429 pinned card */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderRadius: 14, background: 'rgba(255,59,48,0.07)', border: '1px solid rgba(255,59,48,0.3)', marginBottom: 24 }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,59,48,0.14)', color: 'var(--red)' }}><Icon name="alert" size={19} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Market Scan hit its $30 cap and paused</span>
            <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>1 job is waiting · raise the cap or review what's running.</span>
          </span>
          <button onClick={() => { const target = caps.find(c => c.capped) ?? caps[0]; if (target) setEditCap(target); }} className="primary-cta" style={{ height: 36, padding: '0 15px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', boxShadow: '0 4px 14px rgba(0,122,255,0.28)' }}>Raise cap</button>
          <button className="ghost-btn" style={{ height: 36, padding: '0 15px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Review jobs</button>
        </div>

        <HeroBand cap={cap} spent={spent} />

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 18, marginBottom: 24, alignItems: 'start' }}>
          <div>
            <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 12 }}>Per-project caps</div>
            <CapsList caps={caps} onEdit={setEditCap} />
          </div>
          <SavingsCard />
        </div>

        <div style={{ marginBottom: 24 }}><Breakdown /></div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 18, alignItems: 'start' }}>
          <div>
            <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 12 }}>Ledger</div>
            <BgLedger />
          </div>
          <RulesSection />
        </div>
      </div>

      {editCap && <CapEditSheet cap={editCap} onClose={() => setEditCap(null)} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
