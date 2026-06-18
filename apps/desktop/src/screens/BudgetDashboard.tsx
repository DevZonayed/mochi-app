/* Costs — spend analytics for a CLI-subscription operator. There are NO budget
   caps here: using your own Claude Code / Codex sign-ins, jobs aren't billed
   per-run, so we only ever calculate and show what's been spent. This month /
   Today / Projected, a 14-day trend, by-engine and by-project breakdowns, a
   "what's included in your subscription" card, and a real ledger of runs.
   Route stays /budget; the label is "Costs". */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { api, type CostsData, type Job, type Project } from '../lib/api';

const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }
  .led-row:hover { background: var(--fill-tertiary); }
  .count-num { animation: countUp 400ms var(--spring); }
  @keyframes countUp { from { transform: translateY(-4px); } to { transform: none; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

function GlassStat({ children }: { children?: React.ReactNode }) {
  return <div style={{ background: 'var(--bg-grouped)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 22, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>{children}</div>;
}

// ── Hero: this month / today / projected (all real, no caps) ──────────────────
function HeroBand({ costs }: { costs: CostsData }) {
  const spark = costs.byDay;
  const maxS = Math.max(1, ...spark.map(d => d.total));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 18, marginBottom: 26 }}>
      <GlassStat>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>This month</div>
        <div className="count-num" style={{ font: '700 40px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>${costs.thisMonth.toFixed(2)}</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
          <Icon name="check" size={12} stroke={2.6} /> No cap — subscription
        </div>
      </GlassStat>
      <GlassStat>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>Today</div>
        <div className="count-num" style={{ font: '700 40px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>${costs.today.toFixed(2)}</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 44, marginTop: 16 }}>
          {spark.map((d, i) => <div key={i} title={`${d.day} · $${d.total.toFixed(2)}`} style={{ flex: 1, height: `${Math.max(3, (d.total / maxS) * 100)}%`, borderRadius: 2, background: i === spark.length - 1 ? 'var(--blue)' : 'color-mix(in srgb, var(--blue) 35%, transparent)' }} />)}
        </div>
        <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 6 }}>by day · last 14d</div>
      </GlassStat>
      <GlassStat>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 8 }}>Projected</div>
        <div className="count-num" style={{ font: '700 40px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>≈ ${costs.projectedMonth.toFixed(0)}</div>
        <div style={{ font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 8 }}>this month at the current pace</div>
      </GlassStat>
    </div>
  );
}

const ENGINE_TINT: Record<string, string> = { claude: 'var(--blue)', codex: 'var(--ink)', 'media (fal)': 'var(--purple)' };
const ENGINE_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

// ── By engine / by project breakdown ──────────────────────────────────────────
function Breakdown({ costs }: { costs: CostsData }) {
  const [mode, setMode] = React.useState<'engine' | 'project'>('engine');
  const rows = mode === 'engine'
    ? costs.byEngine.map(e => ({ label: ENGINE_NAME[e.engine] ?? e.engine, tint: ENGINE_TINT[e.engine] ?? 'var(--teal)', v: e.total, sub: `${e.jobs} run${e.jobs !== 1 ? 's' : ''}` }))
    : costs.byProject.map(p => ({ label: p.name, tint: `var(--${p.color})`, v: p.total, sub: `${p.jobs} job${p.jobs !== 1 ? 's' : ''}` }));
  const total = Math.max(0.0001, rows.reduce((a, b) => a + b.v, 0));
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)', flex: 1 }}>Cost breakdown</span>
        {(['engine', 'project'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} style={{ height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)', font: '600 var(--fs-caption)/1 var(--font-text)', background: mode === m ? 'var(--blue)' : 'var(--fill-secondary)', color: mode === m ? '#fff' : 'var(--ink-secondary)' }}>{m === 'engine' ? 'By engine' : 'By project'}</button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '22px 0', textAlign: 'center', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No spend yet.</div>
      ) : (
        <>
          <div style={{ display: 'flex', height: 28, borderRadius: 8, overflow: 'hidden', marginBottom: 16, background: 'var(--fill-secondary)' }}>
            {rows.map((b, i) => <div key={i} title={b.label} style={{ width: `${(b.v / total) * 100}%`, background: b.tint }} />)}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
            {rows.map((b, i) => (
              <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: b.tint }} />
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{b.label}</span>
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${b.v.toFixed(2)}</span>
                <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>· {b.sub}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── What your subscription covers ─────────────────────────────────────────────
function IncludedCard({ costs }: { costs: CostsData }) {
  return (
    <div style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--green) 12%, var(--bg-elevated)), var(--bg-elevated))', borderRadius: 16, border: '0.5px solid rgba(52,199,89,0.3)', boxShadow: 'var(--card-shadow)', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--green)', color: '#fff', flexShrink: 0 }}><Icon name="check" size={20} stroke={2.6} /></span>
        <div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Runs on your subscriptions</div>
          <div className="count-num" style={{ font: '700 var(--fs-title1)/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--green)' }}>{costs.includedCodexRuns + costs.claudeRuns} runs</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>no per-run billing</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="terminal" size={14} style={{ color: 'var(--blue)' }} />
          <span style={{ flex: 1, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Claude Code <span style={{ color: 'var(--ink-tertiary)' }}>· your plan</span></span>
          <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{costs.claudeRuns}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="cpu" size={14} style={{ color: 'var(--ink)' }} />
          <span style={{ flex: 1, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Codex <span style={{ color: 'var(--ink-tertiary)' }}>· ChatGPT login</span></span>
          <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{costs.includedCodexRuns}</span>
        </div>
        <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 4 }}>
          Media on fal (images / video / voice) is real metered spend and shows in the breakdown.
        </div>
      </div>
    </div>
  );
}

// ── Real ledger of runs ───────────────────────────────────────────────────────
function clockOf(ts: number): string {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (ts >= today.getTime()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function Ledger({ jobs, projects, onOpen }: { jobs: Job[]; projects: Record<string, Project>; onOpen: (id: string) => void }) {
  const rows = jobs.filter(j => j.status === 'done' || j.cost > 0).slice(0, 40);
  if (rows.length === 0) {
    return (
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: '40px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
        No runs yet. Costs appear here as jobs complete.
      </div>
    );
  }
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '70px 1.4fr 1.6fr 0.9fr 0.8fr', gap: 14, padding: '11px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {['Time', 'Project ▸ Job', 'Engine', 'Tokens', 'Cost'].map((h, i) => <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', textAlign: i === 4 ? 'right' : 'left' }}>{h}</span>)}
      </div>
      {rows.map((j, i) => (
        <div key={j.id} onClick={() => onOpen(j.id)} className="led-row" style={{ display: 'grid', gridTemplateColumns: '70px 1.4fr 1.6fr 0.9fr 0.8fr', gap: 14, alignItems: 'center', padding: '12px 18px', borderBottom: i < rows.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer' }}>
          <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{clockOf(j.createdAt)}</span>
          <span style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><b style={{ fontWeight: 600 }}>{projects[j.projectId]?.name ?? 'Project'}</b> <span style={{ color: 'var(--ink-tertiary)' }}>▸ {j.title}</span></span>
          <span style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)' }}>{ENGINE_NAME[j.engine ?? 'claude'] ?? j.engine}{j.model && j.model !== j.engine ? ` · ${j.model}` : ''}</span>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{j.tokens ? `${(j.tokens / 1000).toFixed(1)}k` : '—'}</span>
          <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', textAlign: 'right' }}>${j.cost.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

// ── ⌘K command palette ────────────────────────────────────────────────────────
interface PaletteItem { group: string; icon: IconName; label: string; hint: string; }
const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Jump to', icon: 'layers', label: 'Projects', hint: '⌘2' },
  { group: 'Jump to', icon: 'jobs', label: 'Jobs', hint: '⌘3' },
  { group: 'Jump to', icon: 'shield', label: 'Approvals', hint: '⌘4' },
];

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 60); } }, [open]);
  if (!open) return null;
  const filtered = PALETTE_ITEMS.filter(it => it.label.toLowerCase().includes(q.toLowerCase()));
  const go = (label: string) => { onClose(); const map: Record<string, string> = { Projects: '/projects', Jobs: '/job-monitor', Approvals: '/approvals' }; if (map[label]) navigate(map[label]); };
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'flex', justifyContent: 'center', paddingTop: 132, background: 'rgba(10,12,24,0.28)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} style={{ width: 640, maxHeight: 460, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)', boxShadow: '0 30px 80px rgba(10,15,40,0.45), var(--glass-inner)', overflow: 'hidden', animation: 'palettePop 200ms var(--spring)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="search" size={19} style={{ color: 'var(--ink-tertiary)' }} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Jump to…" style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-title2)/1 var(--font-text)', color: 'var(--ink)' }} />
          <span style={{ padding: '3px 7px', borderRadius: 5, background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>esc</span>
        </div>
        <div style={{ overflowY: 'auto', padding: 8 }}>
          {filtered.length === 0 && <div style={{ padding: '28px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No matches</div>}
          {filtered.map(it => (
            <div key={it.label} onMouseDown={() => go(it.label)} style={{ display: 'flex', alignItems: 'center', gap: 11, height: 42, padding: '0 10px', borderRadius: 9, cursor: 'pointer' }} className="led-row">
              <span style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}><Icon name={it.icon} size={16} /></span>
              <span style={{ flex: 1, font: '500 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{it.label}</span>
              <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{it.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Costs body (chrome-less) ───────────────────────────────────────────────────
/* Used standalone (wrapped in AppShell below) and embedded as a Settings pane. */
export function BudgetPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const [costs, setCosts] = React.useState<CostsData | null>(null);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [projects, setProjects] = React.useState<Record<string, Project>>({});

  const load = React.useCallback(() => {
    api.costs().then(setCosts).catch(() => {});
    api.listJobs().then(setJobs).catch(() => {});
    api.listProjects().then(ps => setProjects(Object.fromEntries(ps.map(p => [p.id, p])))).catch(() => {});
  }, []);
  React.useEffect(() => {
    load();
    const unsub = api.subscribe({ onJob: load });
    return unsub;
  }, [load]);

  const c = costs ?? { today: 0, thisMonth: 0, projectedMonth: 0, byDay: [], byProject: [], byEngine: [], includedCodexRuns: 0, claudeRuns: 0 };
  const hasSpend = c.thisMonth > 0 || jobs.length > 0;

  return (
    <div style={{ padding: embedded ? 0 : '24px 28px 36px' }}>
      <style>{styles}</style>
      <h1 style={{ margin: '0 0 4px', font: `700 ${embedded ? 'var(--fs-title1)' : 'var(--fs-large-title)'}/1 var(--font-display)`, letterSpacing: '-0.02em', color: 'var(--ink)' }}>Costs</h1>
      <p style={{ margin: '0 0 22px', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>What you've spent — no caps, since jobs run on your own subscriptions.</p>

      <HeroBand costs={c} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 18, marginBottom: 24, alignItems: 'start' }}>
        <Breakdown costs={c} />
        <IncludedCard costs={c} />
      </div>

      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 12 }}>Ledger</div>
      {hasSpend ? <Ledger jobs={jobs} projects={projects} onOpen={(id) => navigate(`/session-transcript/${id}`)} />
        : <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: '40px 0', textAlign: 'center', font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>No runs yet. Costs appear here as jobs complete.</div>}
    </div>
  );
}

// ── Page root ────────────────────────────────────────────────────────────────
export default function BudgetDashboard() {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <AppShell active="budget" onSearch={() => setPaletteOpen(true)}>
      <BudgetPanel />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
