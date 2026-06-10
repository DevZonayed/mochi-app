/* Command Center — page assembly. Greeting, needs-you strip, jobs + rail,
   ⌘K palette, live streaming tick, approve micro-interaction.
   Ported to ES-module TypeScript React — visual output unchanged. */

import React from 'react';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { Spinner } from '../lib/ui';

/* ───────────────────────── page-specific CSS (from <Page>.html) ───────────────────────── */
const styles = `
  /* job rows */
  .job-row { transition: border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease; }
  .job-row:hover { border-color: var(--separator-strong); transform: translateY(-1px); }
  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe {
    0%,100% { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 0%, transparent); opacity: 1; }
    50% { opacity: 0.55; }
  }
  .stream-line span { animation: streamIn 2.2s ease; }
  @keyframes streamIn { 0% { opacity: 0.2; transform: translateY(5px); } 12%,82% { opacity: 1; transform: none; } 100% { opacity: 0.55; } }

  /* gate cards */
  .gate-card { position: relative; transition: transform 220ms var(--spring), opacity 220ms ease, box-shadow 140ms ease; }
  .gate-card:hover { box-shadow: var(--card-shadow), 0 0 0 0.5px var(--separator-strong); }
  .gate-approve { transition: background 120ms ease, transform 100ms ease; }
  .gate-approve:hover { background: var(--blue-press); }
  .gate-approve:active { transform: translateY(1px); }
  .gate-review:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 6%); }
  .gate-approving { animation: gateApprove 360ms var(--spring) forwards; }
  .gate-approving .gate-check { animation: gateCheck 360ms var(--spring) forwards; }
  @keyframes gateApprove { to { transform: scale(0.9); opacity: 0; } }
  @keyframes gateCheck { 0% { opacity: 0; } 30% { opacity: 1; } 100% { opacity: 1; } }
  .gate-check > span { animation: checkPop 360ms var(--spring); }
  @keyframes checkPop { 0% { transform: scale(0.4); } 60% { transform: scale(1.12); } 100% { transform: scale(1); } }

  .needs-scroll::-webkit-scrollbar { height: 0; }

  /* primary CTA */
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }

  /* palette — frozen-clock-safe (no opacity-0 start) */
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

/* ───────────────────────── data ───────────────────────── */
interface Project { name: string; color: string; }
const PROJECTS: Record<string, Project> = {
  atlas:   { name: 'Atlas API',     color: 'var(--blue)' },
  brand:   { name: 'Brand Refresh', color: 'var(--teal)' },
  content: { name: 'Q3 Content',    color: 'var(--purple)' },
  scan:    { name: 'Market Scan',   color: 'var(--indigo)' },
};

function ProjectChip({ id, small }: { id: string; small?: boolean }) {
  const p = PROJECTS[id];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color, flexShrink: 0 }} />
      <span style={{ font: `600 ${small ? 'var(--fs-caption)' : 'var(--fs-footnote)'}/1 var(--font-text)`, color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{p.name}</span>
    </span>
  );
}

/* ───────────────────────── Needs-you strip ───────────────────────── */
interface Gate {
  id: string;
  project: string;
  type: string;
  icon: IconName;
  tint: string;
  summary: string;
  meta: string;
  age: string;
}

const GATES: Gate[] = [
  { id: 'g1', project: 'atlas',   type: 'merge',   icon: 'gitMerge', tint: 'var(--blue)',   summary: 'Merge PR #482 — auth refactor',     meta: '12 files · +840 −210',          age: '4 min' },
  { id: 'g2', project: 'scan',    type: 'budget',  icon: 'alert',    tint: 'var(--red)',    summary: 'Deep run will exceed the $5 cap',   meta: 'Est. $6.40 · competitor digest', age: '1 min' },
  { id: 'g3', project: 'content', type: 'publish', icon: 'send',     tint: 'var(--purple)', summary: 'Publish “Launch week” thread to X', meta: '6 posts · scheduled 14:00',      age: '9 min' },
  { id: 'g4', project: 'brand',   type: 'plan',    icon: 'sliders',  tint: 'var(--teal)',   summary: 'Approve export plan — icon set @3x', meta: '48 assets · 2 formats',         age: '12 min' },
];

function NeedsYouStrip({ gates, onApprove }: { gates: Gate[]; onApprove: (id: string) => void }) {
  if (gates.length === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px',
        background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)',
      }}>
        <span style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(52,199,89,0.16)', color: 'var(--green)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="check" size={19} stroke={2.5} />
        </span>
        <span style={{ font: '500 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Nothing needs you — the fleet is working.</span>
      </div>
    );
  }
  return (
    <div>
      <ZoneLabel icon="shield" tint="var(--red)">Needs you · {gates.length}</ZoneLabel>
      <div className="needs-scroll" style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 6, scrollbarWidth: 'none' }}>
        {gates.map(g => (
          <div key={g.id} data-gate={g.id} className="gate-card" style={{
            width: 290, flexShrink: 0, background: 'var(--bg-elevated)', borderRadius: 14,
            border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 14,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center',
                background: `color-mix(in srgb, ${g.tint} 15%, transparent)`, color: g.tint }}>
                <Icon name={g.icon} size={17} />
              </span>
              <ProjectChip id={g.project} />
              <span style={{ flex: 1 }} />
              <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{g.age}</span>
            </div>
            <div>
              <div style={{ font: '600 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' as React.CSSProperties['textWrap'] }}>{g.summary}</div>
              <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 3 }}>{g.meta}</div>
            </div>
            <div className="gate-actions" style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
              <button onClick={() => onApprove(g.id)} style={{
                flex: 1, height: 32, borderRadius: 8, background: 'var(--blue)', color: '#fff',
                font: '600 var(--fs-footnote)/1 var(--font-text)',
              }} className="gate-approve">{g.type === 'budget' ? 'Raise cap' : 'Approve'}</button>
              <button style={{
                flex: 1, height: 32, borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)',
                font: '600 var(--fs-footnote)/1 var(--font-text)',
              }} className="gate-review">Review</button>
            </div>
            <div className="gate-check" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
              background: 'rgba(52,199,89,0.12)', borderRadius: 14, opacity: 0, pointerEvents: 'none' }}>
              <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--green)', color: '#fff', display: 'grid', placeItems: 'center' }}>
                <Icon name="check" size={22} stroke={3} />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Active jobs ───────────────────────── */
interface Job {
  id: string;
  project: string;
  title: string;
  status: string;
  tint: string;
  progress: number;
  tokens: string;
  cost: string;
  elapsed: string;
  review?: boolean;
  stream: string[];
}

const JOBS: Job[] = [
  { id: 'j1', project: 'atlas', title: 'Refactor auth service', status: 'Building', tint: 'var(--purple)', progress: 64, tokens: '18.2k', cost: '0.42', elapsed: '4:21',
    stream: ['writing migration for sessions table…', 'updating middleware/verifyToken.ts', 'running typecheck — 0 errors', 'patching 3 call sites in routes/'] },
  { id: 'j2', project: 'brand', title: 'Export icon set @3x', status: 'Rendering', tint: 'var(--teal)', progress: 88, tokens: '6.1k', cost: '0.12', elapsed: '1:08',
    stream: ['rasterizing nav-home@3x.png', 'optimizing with pngquant…', 'zipping 48 assets'] },
  { id: 'j3', project: 'content', title: 'Draft launch thread', status: 'Reviewing', tint: 'var(--orange)', progress: 100, tokens: '11.4k', cost: '0.07', elapsed: '0:52', review: true,
    stream: ['scoring hook variants…', 'awaiting your review'] },
  { id: 'j4', project: 'atlas', title: 'Add rate-limiter tests', status: 'Building', tint: 'var(--purple)', progress: 32, tokens: '9.7k', cost: '0.21', elapsed: '2:55',
    stream: ['generating fixtures for 429 path', 'mocking Redis token bucket', 'asserting retry-after header'] },
];

function ActiveJobs({ tick }: { tick: number }) {
  return (
    <div>
      <ZoneLabel icon="bolt" tint="var(--purple)">Active jobs · {JOBS.length}</ZoneLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {JOBS.map((j, i) => {
          const line = j.stream[(tick + i) % j.stream.length];
          return (
            <div key={j.id} className="job-row" style={{
              background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
              boxShadow: 'var(--card-shadow)', padding: '13px 16px', cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={j.review ? '' : 'breathe'} style={{ width: 9, height: 9, borderRadius: 5, background: j.tint, flexShrink: 0,
                  boxShadow: `0 0 0 4px color-mix(in srgb, ${j.tint} 16%, transparent)` }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.title}</span>
                    <ProjectChip id={j.project} small />
                  </div>
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 var(--fs-footnote)/1 var(--font-text)', color: j.tint, flexShrink: 0 }}>
                  {j.review ? <Icon name="enter" size={14} /> : <Spinner size={12} color={j.tint} />}
                  {j.status}
                </span>
              </div>

              {/* progress + meters */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 11 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                  <div style={{ width: `${j.progress}%`, height: '100%', borderRadius: 2,
                    background: j.review ? 'var(--orange)' : 'var(--blue)', transition: 'width 600ms var(--spring)' }} />
                </div>
                <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{j.tokens} tok</span>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>${j.cost}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>
                  <Icon name="clock" size={12} /> {j.elapsed}
                </span>
              </div>

              {/* streaming line */}
              {!j.review && (
                <div className="stream-line" style={{ marginTop: 9, position: 'relative', height: 16, overflow: 'hidden' }}>
                  <span style={{ position: 'absolute', color: 'var(--ink-tertiary)', font: '400 var(--fs-caption)/16px var(--font-mono)', whiteSpace: 'nowrap' }}>
                    <span style={{ color: j.tint, marginRight: 6 }}>›</span>{line}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────── Right rail ───────────────────────── */
const SCHEDULE = [
  { time: '14:00', project: 'scan',    label: 'Competitor digest' },
  { time: '16:30', project: 'content', label: 'Newsletter draft' },
  { time: '18:00', project: 'atlas',   label: 'Nightly test suite' },
  { time: '21:00', project: 'brand',   label: 'Asset backup' },
  { time: '06:00', project: 'atlas',   label: 'Dependency audit' },
];
const SPEND = [
  { project: 'atlas',   amount: 18.4 },
  { project: 'content', amount: 9.1 },
  { project: 'scan',    amount: 6.8 },
  { project: 'brand',   amount: 3.9 },
];
const DONE: { ok: boolean; project: string; title: string; cost: string }[] = [
  { ok: true,  project: 'brand',   title: 'Generate OG images',  cost: '0.34' },
  { ok: true,  project: 'scan',    title: 'Summarize tickets',   cost: '0.11' },
  { ok: false, project: 'atlas',   title: 'Deploy preview',      cost: '0.02' },
  { ok: true,  project: 'content', title: 'Translate docs (ES)', cost: '0.46' },
];

function RailCard({ title, action, children }: { title: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ flex: 1, font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{title}</span>
        {action && <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>{action}</span>}
      </div>
      {children}
    </div>
  );
}

function RightRail() {
  const maxSpend = Math.max(...SPEND.map(s => s.amount));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <RailCard title="Today's schedule" action="All">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SCHEDULE.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 0',
              borderBottom: i < SCHEDULE.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', width: 42, flexShrink: 0 }}>{s.time}</span>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: PROJECTS[s.project].color, flexShrink: 0 }} />
              <span style={{ flex: 1, font: '400 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
            </div>
          ))}
        </div>
      </RailCard>

      <RailCard title="Spend today">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SPEND.map((s, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 78, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 }}>{PROJECTS[s.project].name}</span>
              <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                <div style={{ width: `${(s.amount / maxSpend) * 100}%`, height: '100%', borderRadius: 4, background: PROJECTS[s.project].color }} />
              </div>
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', width: 44, textAlign: 'right', flexShrink: 0 }}>${s.amount.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </RailCard>

      <RailCard title="Recently completed">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {DONE.map((d, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
              borderBottom: i < DONE.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
              <Icon name={d.ok ? 'checkCircle' : 'xCircle'} size={16} style={{ color: d.ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
              <span style={{ flex: 1, font: '500 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</span>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: PROJECTS[d.project].color, flexShrink: 0 }} />
              <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 36, textAlign: 'right', flexShrink: 0 }}>${d.cost}</span>
            </div>
          ))}
        </div>
      </RailCard>
    </div>
  );
}

function ZoneLabel({ icon, tint, children }: { icon: IconName; tint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11 }}>
      <Icon name={icon} size={15} style={{ color: tint }} />
      <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{children}</span>
    </div>
  );
}

/* ───────────────────────── ⌘K command palette ───────────────────────── */
interface PaletteItem { group: string; icon: IconName; label: string; hint: string; }

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Actions', icon: 'play',      label: 'Run job…',                       hint: 'Start a new job in a project' },
  { group: 'Actions', icon: 'plus',      label: 'New project…',                   hint: 'From a template' },
  { group: 'Actions', icon: 'calendar',  label: 'Schedule a run…',                hint: 'Pick time & cadence' },
  { group: 'Actions', icon: 'gauge',     label: 'Adjust budget cap…',             hint: 'Workspace or project' },
  { group: 'Recent',  icon: 'gitMerge',  label: 'Merge PR #482 — auth refactor',  hint: 'Atlas API' },
  { group: 'Recent',  icon: 'send',      label: 'Publish “Launch week” thread',   hint: 'Q3 Content' },
  { group: 'Recent',  icon: 'telescope', label: 'Competitor digest',              hint: 'Market Scan' },
  { group: 'Jump to', icon: 'layers',    label: 'Projects',                       hint: '⌘2' },
  { group: 'Jump to', icon: 'shield',    label: 'Approvals',                      hint: '⌘4' },
];

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 60); }
  }, [open]);

  const filtered = PALETTE_ITEMS.filter(it => it.label.toLowerCase().includes(q.toLowerCase()) || it.hint.toLowerCase().includes(q.toLowerCase()));
  const groups = filtered.reduce((acc, it) => { (acc[it.group] = acc[it.group] || []).push(it); return acc; }, {} as Record<string, PaletteItem[]>);
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

/* ───────────────────────── page root ───────────────────────── */
function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
const TODAY = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export default function CommandCenter() {
  const [tick, setTick] = React.useState(0);
  const [gates, setGates] = React.useState<Gate[]>(GATES);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [spent, setSpent] = React.useState(38.2);

  // streaming ticker
  React.useEffect(() => { const t = setInterval(() => setTick(x => x + 1), 2200); return () => clearInterval(t); }, []);

  // ⌘K
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const approve = (id: string) => {
    const card = document.querySelector(`[data-gate="${id}"]`);
    if (card) {
      card.classList.add('gate-approving');
      setTimeout(() => { setGates(g => g.filter(x => x.id !== id)); setSpent(s => +(s + 0.6).toFixed(2)); }, 360);
    } else {
      setGates(g => g.filter(x => x.id !== id));
    }
  };

  return (
    <AppShell
      active="home"
      onSearch={() => setPaletteOpen(true)}
      budget={{ spent, cap: 200, animateKey: spent }}
    >
      <style>{styles}</style>

      <div style={{ padding: '24px 28px 32px' }}>
        {/* greeting */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22 }}>
          <div>
            <div style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 5 }}>{TODAY}</div>
            <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{greeting()}</h1>
          </div>
          <button onClick={() => setPaletteOpen(true)} className="primary-cta" style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
            background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)',
            boxShadow: '0 6px 18px rgba(0,122,255,0.30)',
          }}>
            <Icon name="play" size={16} /> Run a job
          </button>
        </div>

        {/* needs-you */}
        <div style={{ marginBottom: 24 }}>
          <NeedsYouStrip gates={gates} onApprove={approve} />
        </div>

        {/* jobs + rail */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 20, alignItems: 'start' }}>
          <ActiveJobs tick={tick} />
          <RightRail />
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
