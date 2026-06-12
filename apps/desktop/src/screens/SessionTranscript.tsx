/* Session Transcript — live streaming agent transcript with run outline + meters.
   Ported from the Babel-standalone design prototype (st-app/st-blocks/st-rail.jsx)
   to ES-module TypeScript React. Visual output (inline styles, classNames,
   var(--…) variables, SVG, animation classes) preserved exactly.

   The prototype rendered <WindowFrame><Sidebar/><Toolbar/>…</WindowFrame>; that
   chrome is provided by the shared <AppShell active="jobs">. The page-specific
   job header + 3-column body become AppShell children. Cross-page location.href /
   <a href> navigation is replaced with react-router useNavigate(). */

import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import { EffortDial } from '../lib/ui';
import { AppShell } from '../lib/appShell';
import { api, type Job, type Effort, type TranscriptItem } from '../lib/api';

type RunState = 'live' | 'gate' | 'done' | 'failed';

const PAGE_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }

  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .split-quiet:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 6%); }
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .tool-chip { transition: background 120ms ease; }
  .tool-chip:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .ol-node:hover span, .ckpt:hover { }
  .ckpt:hover { background: var(--fill-tertiary); }
  .ckpt-restore:hover { background: var(--fill-secondary); color: var(--blue); }
  .ctrl:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .ctrl-cancel:hover { background: rgba(255,59,48,0.2); }
  .artifact:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 8%); }
  .jump-pill { transition: transform 140ms var(--spring), box-shadow 160ms ease; }
  .jump-pill:hover { box-shadow: 0 10px 28px rgba(0,122,255,0.5); }

  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
  .stream-caret { animation: blink 1.05s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .ol-pulse { animation: olPulse 1.6s ease-in-out infinite; }
  @keyframes olPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.7); opacity: 0.6; } }

  /* block entrances — frozen-clock-safe (transform only) */
  .gate-block { animation: blockIn 280ms var(--spring); }
  .summary-done, .summary-fail { animation: blockIn 280ms var(--spring); }
  @keyframes blockIn { from { transform: translateY(-6px); } to { transform: none; } }

  /* palette — frozen-clock-safe */
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }

  main::-webkit-scrollbar, aside::-webkit-scrollbar, div::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-thumb { background: var(--fill-secondary); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
  ::selection { background: rgba(0,122,255,0.22); }
`;

/* ───────────────────────── content blocks ───────────────────────── */

interface NarrationProps {
  text?: string;
  streamed?: string | null;
  live?: boolean;
}

// Agent narration (SF Pro body); `streamed` enables typewriter + caret
function Narration({ text, streamed, live }: NarrationProps) {
  return (
    <div style={{ font: '400 var(--fs-body)/1.7 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' as React.CSSProperties['textWrap'], maxWidth: 720 }}>
      {streamed != null ? streamed : text}
      {live && <span className="stream-caret" style={{ display: 'inline-block', width: 8, height: 19, background: 'var(--purple)', borderRadius: 1, marginLeft: 2, verticalAlign: 'text-bottom' }} />}
    </div>
  );
}

// User goal / prompt for the job (the live `input`), shown atop the transcript.
function GoalBlock({ goal }: { goal: string }) {
  return (
    <div style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        <Icon name="send" size={14} style={{ color: 'var(--blue)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Goal</span>
      </div>
      <div style={{ padding: '12px 14px', font: '400 var(--fs-body)/1.6 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' as React.CSSProperties['textWrap'] }}>{goal}</div>
    </div>
  );
}

/* Tool glyph/tint by name — mirrors the chat's ToolNode so the transcript reads
   the same in both places. */
function toolMeta(name: string): { icon: IconName; tint: string } {
  const n = name.toLowerCase();
  if (/bash|shell|command|exec|terminal/.test(n)) return { icon: 'terminal', tint: 'var(--blue)' };
  if (/read|write|edit|glob|grep|notebook|file|patch|ls/.test(n)) return { icon: 'folder', tint: 'var(--teal)' };
  if (/web|search|fetch|browser/.test(n)) return { icon: 'telescope', tint: 'var(--indigo)' };
  if (/skill|task|agent|subagent/.test(n)) return { icon: 'spark', tint: 'var(--purple)' };
  return { icon: 'command', tint: 'var(--ink-secondary)' };
}
const fmtToolDur = (ms?: number): string => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);

/* Lightweight prose: split out ``` fenced code blocks; render the rest as
   line-break-preserving paragraphs. Good enough for agent text + JSON output
   without dragging in the full chat markdown renderer. */
function renderText(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  text.split(/```/).forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const body = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n+$/, '');
      out.push(<pre key={`${keyBase}-c${i}`} style={{ margin: 0, maxWidth: 720, padding: '12px 14px', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 10, font: '400 12.5px/1.6 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{body}</pre>);
    } else if (part.trim()) {
      out.push(<div key={`${keyBase}-p${i}`} style={{ font: '400 var(--fs-body)/1.7 var(--font-text)', color: 'var(--ink)', whiteSpace: 'pre-wrap', textWrap: 'pretty' as React.CSSProperties['textWrap'], maxWidth: 720 }}>{part.trim()}</div>);
    }
  });
  return out;
}

// One real tool step from the job's transcript.
function ToolStep({ item }: { item: TranscriptItem }) {
  const running = item.toolStatus === 'running';
  const error = item.toolStatus === 'error';
  const { icon, tint } = toolMeta(item.name ?? '');
  const accent = error ? 'var(--red)' : tint;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, maxWidth: 720, padding: '7px 11px 7px 8px', borderRadius: 11,
      background: error ? 'color-mix(in srgb, var(--red) 8%, var(--bg-elevated))' : `color-mix(in srgb, ${tint} 9%, var(--bg-elevated))`,
      border: `0.5px solid color-mix(in srgb, ${accent} 30%, var(--separator))` }}>
      <span style={{ width: 22, height: 22, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}><Icon name={icon} size={13} /></span>
      <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', flexShrink: 0 }}>{item.name}</span>
      {item.text && <span style={{ flex: 1, minWidth: 0, font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.text}</span>}
      <span style={{ flexShrink: 0, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {running ? <span className="breathe" style={{ width: 8, height: 8, borderRadius: 4, background: tint }} />
          : error ? <Icon name="x" size={12} stroke={2.6} style={{ color: 'var(--red)' }} />
          : <><span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{fmtToolDur(item.durMs)}</span><Icon name="check" size={11} stroke={2.6} style={{ color: 'var(--green)' }} /></>}
      </span>
    </div>
  );
}

// A question the agent asked during the run (read-only here).
function AskStep({ text }: { text: string }) {
  return (
    <div style={{ maxWidth: 720, background: 'color-mix(in srgb, var(--blue) 6%, var(--bg-elevated))', border: '0.5px solid color-mix(in srgb, var(--blue) 28%, var(--separator))', borderRadius: 12, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6, font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--blue)' }}>
        <Icon name="command" size={13} /> Question
      </div>
      <div style={{ font: '400 var(--fs-body)/1.6 var(--font-text)', color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  );
}

/* The REAL transcript for this job: its prompt, then each structured item
   (text / tool / question) from job.transcript, falling back to job.output /
   job.error when a run has no structured transcript. */
function transcriptBlocks(job: Job | null, live: boolean): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  if (job?.input) blocks.push(<GoalBlock key="goal" goal={job.input} />);
  const items = job?.transcript ?? [];
  if (items.length) {
    items.forEach((it, i) => {
      if (it.kind === 'tool') blocks.push(<ToolStep key={`it${i}`} item={it} />);
      else if (it.kind === 'ask') blocks.push(<AskStep key={`it${i}`} text={it.ask || it.text} />);
      else if (it.text && it.text.trim()) blocks.push(<React.Fragment key={`it${i}`}>{renderText(it.text, `it${i}`)}</React.Fragment>);
    });
  } else if (job) {
    const body = (job.error ?? job.output ?? '').trim();
    if (body) blocks.push(<React.Fragment key="out">{renderText(body, 'out')}</React.Fragment>);
    else if (!live) blocks.push(<Narration key="empty" text="No transcript was recorded for this run." />);
  }
  if (live) blocks.push(<span key="caret" className="stream-caret" style={{ display: 'inline-block', width: 8, height: 19, background: 'var(--purple)', borderRadius: 1 }} />);
  return blocks;
}

interface RailMeterProps {
  label: string;
  value: string;
  tint?: string;
}

function RailMeter({ label, value, tint }: RailMeterProps) {
  return (
    <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', padding: '12px 14px' }}>
      <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 6 }}>{label}</div>
      <div style={{ font: '600 var(--fs-title2)/1 var(--font-mono)', color: tint || 'var(--ink)', letterSpacing: '-0.01em' }}>{value}</div>
    </div>
  );
}

function RailLabel({ children }: { children?: React.ReactNode }) {
  return <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>{children}</div>;
}

function EffortPill({ v }: { v: 'FAST' | 'BALANCED' | 'DEEP' | 'MAX' }) {
  const t = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' }[v];
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
    background: `color-mix(in srgb, ${t} 14%, transparent)`, color: t, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em' }}>{v}</span>;
}

interface RightRailProps {
  cost: number;
  tokens: string;
  elapsed: string;
  effort: 'FAST' | 'BALANCED' | 'DEEP' | 'MAX';
  engine?: string;
  model?: string;
  live: boolean;
  onCancel: () => void;
}

// Right rail: real run meters + effort + cancel (no invented skills/roles).
function RightRail({ cost, tokens, elapsed, effort, engine, model, live, onCancel }: RightRailProps) {
  return (
    <aside style={{ width: 300, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18,
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* real meters */}
      <div style={{ display: 'flex', gap: 10 }}>
        <RailMeter label="Cost" value={`$${cost.toFixed(2)}`} />
        <RailMeter label="Tokens" value={tokens} />
      </div>
      <RailMeter label="Elapsed" value={elapsed} />

      {/* real effort */}
      <div>
        <RailLabel>Effort</RailLabel>
        <EffortPill v={effort} />
      </div>

      {/* real engine / model */}
      {engine && (
        <div>
          <RailLabel>Engine</RailLabel>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 11px', borderRadius: 9, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
            <Icon name={engine === 'codex' ? 'cpu' : 'terminal'} size={14} style={{ color: 'var(--ink)' }} />
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{ENGINE_LABEL[engine] ?? engine}</span>
            {model && model !== engine && <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>· {model}</span>}
          </div>
        </div>
      )}

      <span style={{ flex: 1 }} />

      {/* control */}
      {live && (
        <button onClick={onCancel} className="ctrl-cancel" style={{ height: 40, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, position: 'sticky', bottom: 0,
          background: 'rgba(255,59,48,0.12)', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="x" size={15} /> Cancel run</button>
      )}
    </aside>
  );
}

/* ───────────────────────── ⌘K command palette ───────────────────────── */

interface PaletteItem {
  group: string;
  icon: IconName;
  label: string;
  hint: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
  { group: 'Jump to', icon: 'home', label: 'Command Center', hint: '⌘1' },
  { group: 'Jump to', icon: 'layers', label: 'Projects', hint: '⌘2' },
  { group: 'Jump to', icon: 'jobs', label: 'Jobs', hint: '⌘3' },
  { group: 'Jump to', icon: 'shield', label: 'Approvals', hint: '⌘4' },
  { group: 'Jump to', icon: 'clapper', label: 'Studio', hint: '' },
  { group: 'Jump to', icon: 'telescope', label: 'Trends', hint: '' },
  { group: 'Jump to', icon: 'send', label: 'Publishing', hint: '' },
  { group: 'Jump to', icon: 'gauge', label: 'Costs', hint: '' },
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

/* ───────────────────────────── page root ───────────────────────────── */

// Map the live job status onto the screen's RunState vocabulary. The API has no
// "gate" state — that only arrives via the demo state-switch / Pause control.
function statusToRunState(s: Job['status']): RunState {
  if (s === 'done') return 'done';
  if (s === 'failed' || s === 'cancelled') return 'failed';
  return 'live'; // pending | running
}

const ENGINE_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const EFFORT_TO_PILL: Record<Effort, 'FAST' | 'BALANCED' | 'DEEP' | 'MAX'> = {
  fast: 'FAST',
  balanced: 'BALANCED',
  deep: 'DEEP',
  max: 'MAX',
};

export default function SessionTranscript() {
  const navigate = useNavigate();
  const { id: routeId } = useParams<{ id: string }>();
  const [runState, setRunState] = React.useState<RunState>('live');
  const [cost, setCost] = React.useState(0.42);
  const [tokens, setTokens] = React.useState('31.8k');
  const [elapsed, setElapsed] = React.useState(252); // seconds
  const [atBottom, setAtBottom] = React.useState(true);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [job, setJob] = React.useState<Job | null>(null);
  const [projectName, setProjectName] = React.useState<string>('Project');
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const live = runState === 'live';

  // Pick + load the live job: route id if present, else first 'done' (or first) job.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let j: Job | null = null;
        if (routeId) {
          j = await api.getJob(routeId);
        } else {
          const jobs = await api.listJobs();
          j = jobs.find(x => x.status === 'done') ?? jobs[0] ?? null;
          if (j) j = await api.getJob(j.id);
        }
        if (cancelled || !j) return;
        setJob(j);
        setRunState(statusToRunState(j.status));
        setCost(j.cost);
        setTokens(fmtTokens(j.tokens));
        // Derive elapsed from the job's own timestamps (createdAt → updatedAt).
        setElapsed(Math.max(0, Math.round((j.updatedAt - j.createdAt) / 1000)));
        try {
          const p = await api.getProject(j.projectId);
          if (!cancelled) setProjectName(p.name);
        } catch {
          /* keep fallback name */
        }
      } catch {
        /* fail-soft: keep empty initial state, never throw in render */
      }
    })();
    return () => { cancelled = true; };
  }, [routeId]);

  // LIVE: the engine streams partial output + real cost/tokens through job
  // events. Mirror them straight onto the transcript as they arrive.
  React.useEffect(() => {
    const jobId = job?.id;
    if (!jobId) return;
    const unsub = api.subscribe({
      onJob: (j) => {
        if (j.id !== jobId) return;
        setJob(j);
        setRunState(statusToRunState(j.status));
        setCost(j.cost);
        setTokens(fmtTokens(j.tokens));
        setElapsed(Math.max(0, Math.round((j.updatedAt - j.createdAt) / 1000)));
      },
    });
    return unsub;
  }, [job?.id]);

  // elapsed clock only — cost & tokens are real, streamed from the engine
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const scrollToLive = () => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); };
  const onScroll = () => { const el = scrollRef.current; if (!el) return; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60); };
  const followStream = () => { const el = scrollRef.current; if (el && atBottom) el.scrollTop = el.scrollHeight; };

  const mm = Math.floor(elapsed / 60), ss = String(elapsed % 60).padStart(2, '0');

  const statusMap = {
    live: { label: 'Running', tint: 'var(--purple)', pulse: true },
    gate: { label: 'Waiting at gate', tint: 'var(--orange)', pulse: false },
    done: { label: 'Completed', tint: 'var(--green)', pulse: false },
    failed: { label: 'Failed', tint: 'var(--red)', pulse: false },
  }[runState];

  const jumpTo = (phase: string) => { const el = document.getElementById(`phase-${phase}`); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <AppShell active="jobs" onSearch={() => setPaletteOpen(true)}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* job header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', borderBottom: '0.5px solid var(--separator)',
            background: 'color-mix(in srgb, var(--bg) 86%, transparent)', position: 'relative', zIndex: 5 }}>
            <a onClick={e => { e.preventDefault(); navigate('/job-monitor'); }} href="/job-monitor" className="split-quiet" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center',
              background: 'var(--fill-secondary)', color: 'var(--ink)', textDecoration: 'none', flexShrink: 0 }}><Icon name="arrowLeft" size={17} /></a>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 4 }}>
                <span>{projectName}</span><Icon name="chevronRight" size={12} style={{ color: 'var(--ink-tertiary)' }} /><span style={{ color: 'var(--ink)', fontWeight: 600 }}>{job?.title ?? 'Run'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
                  background: `color-mix(in srgb, ${statusMap.tint} 15%, transparent)`, color: statusMap.tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                  <span className={statusMap.pulse ? 'breathe' : ''} style={{ width: 7, height: 7, borderRadius: 4, background: statusMap.tint }} /> {statusMap.label}
                </span>
                {job?.phase && <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{job.phase}</span>}
                <EffortDial value={job ? EFFORT_TO_PILL[job.effort] : 'DEEP'} compact />
              </div>
            </div>
            {/* real engine · model badge — which engine ran this job, on this Mac */}
            {job?.engine && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 28, padding: '0 12px', borderRadius: 'var(--r-pill)',
                background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)', flexShrink: 0 }}>
                <Icon name={job.engine === 'codex' ? 'cpu' : 'terminal'} size={14} style={{ color: 'var(--ink)' }} />
                {ENGINE_LABEL[job.engine] ?? job.engine}{job.model && job.model !== job.engine ? <span style={{ color: 'var(--ink-tertiary)', fontWeight: 500 }}>· {job.model}</span> : null}
              </span>
            )}
            <button className="tb-icon" title="Share / export" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}>
              <Icon name="enter" size={18} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          </div>

          {/* body: real transcript + live meters */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            {/* center transcript */}
            <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
              <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 80px' }}>
                <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {transcriptBlocks(job, live)}
                </div>
              </div>

              {/* jump to live pill */}
              {live && !atBottom && (
                <button onClick={scrollToLive} className="jump-pill" style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 6,
                  display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
                  background: 'var(--blue)', color: '#fff', font: '600 var(--fs-subhead)/1 var(--font-text)', boxShadow: '0 8px 24px rgba(0,122,255,0.4)' }}>
                  Jump to live <Icon name="chevronDown" size={15} />
                </button>
              )}
            </div>

            <RightRail cost={cost} tokens={tokens} elapsed={`${mm}:${ss}`} effort={job ? EFFORT_TO_PILL[job.effort] : 'BALANCED'} engine={job?.engine} model={job?.model} live={live} onCancel={() => { if (job) void api.cancelJob(job.id).catch(() => {}); }} />
          </div>
        </div>
      </AppShell>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
