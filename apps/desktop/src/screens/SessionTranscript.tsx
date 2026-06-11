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
import { EffortDial, ModelSwitcher } from '../lib/ui';
import { AppShell } from '../lib/appShell';
import { api, type Job, type Effort } from '../lib/api';

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

const LIVE_TAIL =
  'Patching the three call sites in routes/ that read req.session directly. Each now resolves the JWT first and falls back to the legacy cookie only when the token is absent, so existing sessions keep working through the rollout.';

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

interface TypewriterProps {
  text: string;
  live?: boolean;
  onTick?: () => void;
}

function Typewriter({ text, live, onTick }: TypewriterProps) {
  const [n, setN] = React.useState(live ? 0 : text.length);
  React.useEffect(() => {
    if (!live) { setN(text.length); return; }
    setN(0);
    const words = text.split(' ');
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setN(words.slice(0, i).join(' ').length);
      onTick && onTick();
      if (i >= words.length) clearInterval(t);
    }, 90);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, live]);
  return <Narration streamed={text.slice(0, n)} live={live} />;
}

interface ToolCallProps {
  tool: string;
  cmd: string;
  time: string;
  ok?: boolean;
  stdout?: string;
}

// Tool call: collapsed mono row, expands inline to stdout
function ToolCall({ tool, cmd, time, ok, stdout }: ToolCallProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ maxWidth: 720 }}>
      <button onClick={() => setOpen(o => !o)} className="tool-chip" style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        padding: '9px 12px', borderRadius: open ? '10px 10px 0 0' : 10, background: 'var(--fill-secondary)', textAlign: 'left',
        border: '0.5px solid var(--separator)', borderBottom: open ? 'none' : '0.5px solid var(--separator)' }}>
        <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 180ms var(--spring)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--purple)', flexShrink: 0 }}>{tool}</span>
        <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
        <span style={{ flex: 1, minWidth: 0, font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cmd}</span>
        <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>{time}</span>
        <Icon name={ok ? 'check' : 'x'} size={13} stroke={2.6} style={{ color: ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
      </button>
      {open && (
        <div className="tool-out" style={{ border: '0.5px solid var(--separator)', borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
          <pre style={{ margin: 0, padding: '12px 14px', background: 'var(--bg-elevated)', font: '400 13px/1.6 var(--font-mono)', color: 'var(--ink-secondary)',
            whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{stdout}</pre>
        </div>
      )}
    </div>
  );
}

interface ThinkingProps {
  tokens: string;
  text: string;
}

// Thinking block (collapsed lavender)
function Thinking({ tokens, text }: ThinkingProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ maxWidth: 720 }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 9, width: open ? '100%' : 'auto',
        padding: '8px 12px', borderRadius: open ? '10px 10px 0 0' : 'var(--r-pill)', background: 'color-mix(in srgb, var(--purple) 9%, transparent)',
        border: '0.5px solid color-mix(in srgb, var(--purple) 22%, transparent)' }}>
        <Icon name="spark" size={14} style={{ color: 'var(--purple)', flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--purple)' }}>Thinking</span>
        <span style={{ font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'color-mix(in srgb, var(--purple) 70%, var(--ink-secondary))' }}>· {tokens} tokens</span>
        <Icon name="chevronDown" size={13} style={{ color: 'var(--purple)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms var(--spring)' }} />
      </button>
      {open && (
        <div style={{ padding: '12px 14px', background: 'color-mix(in srgb, var(--purple) 5%, var(--bg-elevated))', border: '0.5px solid color-mix(in srgb, var(--purple) 18%, transparent)',
          borderTop: 'none', borderRadius: '0 0 10px 10px', font: '400 var(--fs-subhead)/1.6 var(--font-text)', color: 'var(--ink-secondary)', fontStyle: 'italic', textWrap: 'pretty' as React.CSSProperties['textWrap'] }}>{text}</div>
      )}
    </div>
  );
}

type Hunk = { t: 'ctx' | 'add' | 'del'; c: string };

interface DiffCardProps {
  file: string;
  add: number;
  del: number;
  hunks: Hunk[];
}

// File diff card
function DiffCard({ file, add, del, hunks }: DiffCardProps) {
  const navigate = useNavigate();
  return (
    <div style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderBottom: '0.5px solid var(--separator)' }}>
        <Icon name="terminal" size={15} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file}</span>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--green)' }}>+{add}</span>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--red)' }}>−{del}</span>
        <a onClick={e => { e.preventDefault(); navigate('/project-detail'); }} href="/project-detail" className="link-btn" style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none', flexShrink: 0 }}>Open in review →</a>
      </div>
      <div style={{ font: '400 12.5px/1.7 var(--font-mono)', overflowX: 'auto' }}>
        {hunks.map((h, i) => (
          <div key={i} style={{ display: 'flex', padding: '0 0 0 0',
            background: h.t === 'add' ? 'rgba(52,199,89,0.10)' : h.t === 'del' ? 'rgba(255,59,48,0.09)' : 'transparent' }}>
            <span style={{ width: 4, flexShrink: 0, background: h.t === 'add' ? 'var(--green)' : h.t === 'del' ? 'var(--red)' : 'transparent' }} />
            <span style={{ width: 22, flexShrink: 0, textAlign: 'center', color: h.t === 'add' ? 'var(--green)' : h.t === 'del' ? 'var(--red)' : 'var(--ink-tertiary)' }}>{h.t === 'add' ? '+' : h.t === 'del' ? '−' : ' '}</span>
            <span style={{ flex: 1, paddingRight: 12, whiteSpace: 'pre', color: h.t === 'ctx' ? 'var(--ink-tertiary)' : 'var(--ink)' }}>{h.c}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface SystemRowProps {
  icon?: IconName;
  text: string;
}

// System row (quiet grey)
function SystemRow({ icon = 'refresh', text }: SystemRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', maxWidth: 720 }}>
      <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 11px', borderRadius: 'var(--r-pill)',
        background: 'var(--fill-secondary)', font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
        <Icon name={icon} size={13} /> {text}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--separator)' }} />
    </div>
  );
}

interface PhaseMarkerProps {
  phase: string;
  tint: string;
}

// Step label (Plan / Build / Review headers in the stream)
function PhaseMarker({ phase, tint }: PhaseMarkerProps) {
  return (
    <div id={`phase-${phase.toLowerCase()}`} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, maxWidth: 720 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: '0 12px', borderRadius: 'var(--r-pill)',
        background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {phase}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--separator)' }} />
    </div>
  );
}

interface GateCardProps {
  onApprove: () => void;
  onChanges: () => void;
}

// Gate moment (full-width amber)
function GateCard({ onApprove, onChanges }: GateCardProps) {
  const navigate = useNavigate();
  return (
    <div className="gate-block" style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(255,149,0,0.45)',
      boxShadow: '0 0 0 4px rgba(255,149,0,0.10), var(--card-shadow)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '14px 16px', background: 'rgba(255,149,0,0.08)', borderBottom: '0.5px solid var(--separator)' }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'rgba(255,149,0,0.16)', color: 'var(--orange)', flexShrink: 0 }}>
          <Icon name="gitMerge" size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Merge gate · PR #482</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>auth refactor · 12 files · +840 −210 · tests green</div>
        </div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 14, textWrap: 'pretty' as React.CSSProperties['textWrap'] }}>
          Build and review are complete. This is a hard gate — nothing merges or deploys until you approve.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onApprove} className="primary-cta" style={{ height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff',
            font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Approve &amp; merge</button>
          <button onClick={onChanges} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Request changes</button>
          <a onClick={e => { e.preventDefault(); navigate('/project-detail'); }} href="/project-detail" className="link-btn" style={{ height: 40, display: 'inline-flex', alignItems: 'center', padding: '0 12px', color: 'var(--blue)', font: '600 var(--fs-callout)/1 var(--font-text)', textDecoration: 'none' }}>View diff</a>
        </div>
      </div>
    </div>
  );
}

interface MiniStatProps {
  label: string;
  value: string;
}

function MiniStat({ label, value }: MiniStatProps) {
  return (
    <div style={{ flex: 1, background: 'var(--fill-tertiary)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>{label}</div>
      <div style={{ font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

interface SummaryCardProps {
  kind: 'done' | 'failed';
}

// Summary cards (done / failed)
function SummaryCard({ kind }: SummaryCardProps) {
  const navigate = useNavigate();
  if (kind === 'done') {
    return (
      <div className="summary-done" style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(52,199,89,0.4)',
        boxShadow: '0 0 0 4px rgba(52,199,89,0.08), var(--card-shadow)', padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 14 }}>
          <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--green)', color: '#fff', flexShrink: 0 }}><Icon name="check" size={19} stroke={3} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '700 var(--fs-headline)/1.2 var(--font-text)', color: 'var(--ink)' }}>Job complete</div>
            <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Merged to main · all checks green</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <MiniStat label="Total cost" value="$0.58" />
          <MiniStat label="Duration" value="6m 12s" />
          <MiniStat label="Tokens" value="48.2k" />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginRight: 4 }}>Artifacts</span>
          {['PR #482', '3 files changed', 'test report'].map(a => (
            <a key={a} onClick={e => { e.preventDefault(); navigate('/project-detail'); }} href="/project-detail" className="artifact" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)',
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', textDecoration: 'none' }}><Icon name="terminal" size={12} /> {a}</a>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="summary-fail" style={{ maxWidth: 720, background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(255,59,48,0.4)',
      boxShadow: '0 0 0 4px rgba(255,59,48,0.07), var(--card-shadow)', padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
        <span style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(255,59,48,0.14)', color: 'var(--red)', flexShrink: 0 }}><Icon name="alert" size={19} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '700 var(--fs-headline)/1.2 var(--font-text)', color: 'var(--ink)' }}>Job failed</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Stopped at Build · checkpoint 4 preserved</div>
        </div>
      </div>
      <pre style={{ margin: '0 0 14px', padding: '11px 13px', borderRadius: 10, background: 'rgba(255,59,48,0.06)', border: '0.5px solid rgba(255,59,48,0.2)',
        font: '400 12.5px/1.6 var(--font-mono)', color: 'var(--red)', whiteSpace: 'pre-wrap' }}>TypeError: cannot read 'sign' of undefined{'\n'}  at services/jwt.ts:24:18 — missing JWT_SECRET in env</pre>
      <button className="primary-cta" style={{ height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Retry from checkpoint</button>
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

function transcriptBlocks(runState: RunState, onApprove: () => void, onChanges: () => void, onTick: () => void, job: Job | null): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  // Live user goal / prompt for this job (input). The fine-grained timeline rows
  // below have no API source and keep their existing static structure.
  if (job && job.input) {
    blocks.push(<GoalBlock key="goal" goal={job.input} />);
  }
  blocks.push(<PhaseMarker key="pm-plan" phase="Plan" tint="var(--blue)" />);
  blocks.push(<SystemRow key="sys" icon="refresh" text="Resumed from checkpoint after sleep" />);
  blocks.push(<Narration key="n1" text="I'll move the auth service to short-lived JWTs while keeping the legacy cookie path intact. Plan: add a jwt_id column, issue tokens on login, and update the three read sites behind a fallback." />);
  blocks.push(<ToolCall key="t1" tool="read" cmd="src/auth/session.ts" time="0.3s" ok stdout={"export async function getSession(req) {\n  const sid = req.cookies['sid'];\n  return store.get(sid); // ← legacy path\n}"} />);
  blocks.push(<Thinking key="th" tokens="1.4k" text="The cookie path is read in three places. If I gate on the presence of a bearer token first, I can roll out JWTs without breaking active sessions. Migration must be reversible." />);

  blocks.push(<PhaseMarker key="pm-build" phase="Build" tint="var(--purple)" />);
  blocks.push(<Narration key="n2" text="The session table needs a migration. Adding a nullable jwt_id column so we can backfill without downtime." />);
  blocks.push(<DiffCard key="d1" file="migrations/0042_add_jwt_id.sql" add={18} del={0} hunks={[
    { t: 'ctx', c: 'ALTER TABLE sessions' },
    { t: 'add', c: '  ADD COLUMN jwt_id text;' },
    { t: 'add', c: 'CREATE INDEX idx_sessions_jwt' },
    { t: 'add', c: '  ON sessions (jwt_id);' },
  ]} />);
  blocks.push(<ToolCall key="t2" tool="bash" cmd="npm test -- auth" time="3.2s" ok stdout={"PASS  test/auth/session.test.ts\nPASS  test/auth/jwt.test.ts\n\nTests: 24 passed, 24 total\nTime:  3.18 s"} />);
  blocks.push(<ToolCall key="t3" tool="bash" cmd="npm run typecheck" time="5.1s" ok stdout={"tsc --noEmit\n✓ 0 errors"} />);

  // The live result/transcript body comes from job.output (or job.error when failed).
  const resultBody = job ? (job.error ?? job.output) : null;
  if (runState === 'live') {
    blocks.push(<Typewriter key="tail" text={resultBody ?? LIVE_TAIL} live onTick={onTick} />);
  }
  if (runState === 'gate') {
    blocks.push(<Narration key="n3" text={resultBody ?? "Patched all three call sites behind a token-first fallback. Tests green, typecheck clean. Opening the PR for your review."} />);
    blocks.push(<PhaseMarker key="pm-rev" phase="Review" tint="var(--teal)" />);
    blocks.push(<Narration key="n4" text="Reviewer pass complete — no blocking issues. One note: consider rotating the signing key quarterly. Handing off to the merge gate." />);
    blocks.push(<GateCard key="gate" onApprove={onApprove} onChanges={onChanges} />);
  }
  if (runState === 'done') {
    blocks.push(<Narration key="n3" text={resultBody ?? "Patched all three call sites, reviewer signed off, and you approved the merge. Shipped to main."} />);
    blocks.push(<SummaryCard key="sum" kind="done" />);
  }
  if (runState === 'failed') {
    blocks.push(<Narration key="n3" text={resultBody ?? "Wiring the token signer into the login route…"} />);
    blocks.push(<SummaryCard key="sum" kind="failed" />);
  }
  return blocks;
}

/* ───────────────────── left run outline + right rail ───────────────────── */

type PhaseNodeState = 'done' | 'live' | 'todo' | 'fail';

interface RunOutlineProps {
  runState: RunState;
  onJump: (phase: string) => void;
}

// Left: run outline (connected dot-line) + checkpoints
function RunOutline({ runState, onJump }: RunOutlineProps) {
  const phaseStates: Record<'plan' | 'build' | 'review' | 'gate', PhaseNodeState> = ({
    live:   { plan: 'done', build: 'live', review: 'todo', gate: 'todo' },
    gate:   { plan: 'done', build: 'done', review: 'done', gate: 'live' },
    done:   { plan: 'done', build: 'done', review: 'done', gate: 'done' },
    failed: { plan: 'done', build: 'fail', review: 'todo', gate: 'todo' },
  } as Record<RunState, Record<'plan' | 'build' | 'review' | 'gate', PhaseNodeState>>)[runState];
  const nodes: { key: 'plan' | 'build' | 'review' | 'gate'; label: string; meta: string }[] = [
    { key: 'plan', label: 'Plan', meta: '8 steps · 0:42' },
    { key: 'build', label: 'Build', meta: phaseStates.build === 'live' ? 'in progress…' : phaseStates.build === 'fail' ? 'failed' : '14 steps · 3:20' },
    { key: 'review', label: 'Review', meta: phaseStates.review === 'done' ? 'passed' : 'pending' },
    { key: 'gate', label: 'Gate', meta: phaseStates.gate === 'live' ? 'waiting' : phaseStates.gate === 'done' ? 'approved' : 'pending' },
  ];
  const dot = (s: PhaseNodeState): { bg: string; node: React.ReactNode } => {
    if (s === 'done') return { bg: 'var(--green)', node: <Icon name="check" size={11} stroke={3} style={{ color: '#fff' }} /> };
    if (s === 'live') return { bg: 'var(--purple)', node: <span className="ol-pulse" style={{ width: 8, height: 8, borderRadius: 4, background: '#fff' }} /> };
    if (s === 'fail') return { bg: 'var(--red)', node: <Icon name="x" size={11} stroke={3} style={{ color: '#fff' }} /> };
    return { bg: 'var(--fill-secondary)', node: null };
  };
  return (
    <aside style={{ width: 220, flexShrink: 0, borderRight: '0.5px solid var(--separator)', padding: '20px 16px', overflowY: 'auto',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 16 }}>Run outline</div>
      <div style={{ position: 'relative' }}>
        {nodes.map((n, i) => {
          const s = phaseStates[n.key]; const d = dot(s);
          const active = s === 'live';
          return (
            <button key={n.key} onClick={() => onJump(n.key)} className="ol-node" style={{ display: 'flex', gap: 12, width: '100%', textAlign: 'left', padding: '0 0 18px', position: 'relative' }}>
              {i < nodes.length - 1 && <span style={{ position: 'absolute', left: 10, top: 22, bottom: -2, width: 2, background: s === 'done' ? 'var(--green)' : 'var(--separator)' }} />}
              <span style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', zIndex: 1,
                background: d.bg, border: s === 'todo' ? '1.5px solid var(--separator-strong)' : 'none',
                boxShadow: active ? '0 0 0 4px color-mix(in srgb, var(--purple) 16%, transparent)' : 'none' }}>{d.node}</span>
              <span style={{ paddingTop: 1 }}>
                <span style={{ display: 'block', font: `${active ? 700 : 600} var(--fs-callout)/1.1 var(--font-text)`, color: s === 'todo' ? 'var(--ink-tertiary)' : 'var(--ink)' }}>{n.label}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{n.meta}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', margin: '12px 0 12px' }}>Checkpoints</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {([['Checkpoint 4', '2 min ago'], ['Checkpoint 3', '6 min ago'], ['Checkpoint 2', '9 min ago'], ['Checkpoint 1', '12 min ago']] as [string, string][]).map(([c, t], i) => (
          <div key={i} className="ckpt" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8 }}>
            <Icon name="clock" size={13} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>{c}</span>
              <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{t}</span>
            </span>
            <button className="ckpt-restore" title="Restore" style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
              <Icon name="refresh" size={14} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
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

function RoleModels() {
  const [roles, setRoles] = React.useState<Record<string, string>>({ builder: 'opus', reviewer: 'sonnet' });
  const ROWS: [string, string, string][] = [['builder', 'Builder', 'var(--purple)'], ['reviewer', 'Reviewer', 'var(--teal)']];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ROWS.map(([k, label, t]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 84, flexShrink: 0, font: '600 var(--fs-footnote)/1 var(--font-text)', color: t }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: t }} /> {label}
          </span>
          <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
            <ModelSwitcher value={roles[k]} onChange={v => setRoles(r => ({ ...r, [k]: v }))} compact align="right" />
          </span>
        </div>
      ))}
    </div>
  );
}

function ChipRow({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 48, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{label}</span>
      {children}
    </div>
  );
}

function EffortPill({ v }: { v: 'FAST' | 'BALANCED' | 'DEEP' | 'MAX' }) {
  const t = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' }[v];
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
    background: `color-mix(in srgb, ${t} 14%, transparent)`, color: t, font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em' }}>{v}</span>;
}

interface RightRailProps {
  runState: RunState;
  cost: number;
  tokens: string;
  elapsed: string;
  onPause: () => void;
  onCancel: () => void;
}

// Right rail: live meters + chips + controls
function RightRail({ runState, cost, tokens, elapsed, onPause, onCancel }: RightRailProps) {
  const skills = ['TypeScript engineer', 'PR author', 'Test writer'];
  const live = runState === 'live';
  return (
    <aside style={{ width: 300, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18,
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* meters */}
      <div style={{ display: 'flex', gap: 10 }}>
        <RailMeter label="Cost" value={`$${cost.toFixed(2)}`} />
        <RailMeter label="Tokens" value={tokens} />
      </div>
      <RailMeter label="Elapsed" value={elapsed} />

      {/* effort */}
      <div>
        <RailLabel>Effort</RailLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ChipRow label="Build"><EffortPill v="DEEP" /></ChipRow>
          <ChipRow label="Review"><EffortPill v="FAST" /></ChipRow>
        </div>
      </div>

      {/* roles → per-role model switchers */}
      <div>
        <RailLabel>Model per role</RailLabel>
        <RoleModels />
      </div>

      {/* skills */}
      <div>
        <RailLabel>Loaded skills</RailLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {skills.map(s => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', borderRadius: 9, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <Icon name="shield" size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
              <span style={{ flex: 1, font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>{s}</span>
            </div>
          ))}
        </div>
      </div>

      <span style={{ flex: 1 }} />

      {/* controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9, position: 'sticky', bottom: 0 }}>
        {live && (
          <div style={{ display: 'flex', gap: 9 }}>
            <button onClick={onPause} className="ctrl" style={{ flex: 1, height: 40, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="pause" size={15} /> Pause</button>
            <button onClick={onCancel} className="ctrl-cancel" style={{ flex: 1, height: 40, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              background: 'rgba(255,59,48,0.12)', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="x" size={15} /> Cancel</button>
          </div>
        )}
        <button className="ctrl" style={{ height: 40, borderRadius: 'var(--r-pill)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="gitMerge" size={15} /> Fork from checkpoint</button>
      </div>
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
    live: { label: 'Building', tint: 'var(--purple)', pulse: true },
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
                <span>{projectName}</span><Icon name="chevronRight" size={12} style={{ color: 'var(--ink-tertiary)' }} /><span style={{ color: 'var(--ink)', fontWeight: 600 }}>{job?.title ?? 'Refactor auth service'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
                  background: `color-mix(in srgb, ${statusMap.tint} 15%, transparent)`, color: statusMap.tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                  <span className={statusMap.pulse ? 'breathe' : ''} style={{ width: 7, height: 7, borderRadius: 4, background: statusMap.tint }} /> {statusMap.label}
                </span>
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{job?.phase ? job.phase : 'ran at'}</span>
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

          {/* 3-col body */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <RunOutline runState={runState} onJump={jumpTo} />

            {/* center transcript */}
            <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
              {runState === 'gate' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 24px', background: 'rgba(255,149,0,0.12)', borderBottom: '0.5px solid rgba(255,149,0,0.3)' }}>
                  <Icon name="enter" size={17} style={{ color: 'var(--orange)', flexShrink: 0 }} />
                  <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}>Waiting for your approval</span>
                  <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--orange)' }}>· 12 min</span>
                </div>
              )}
              <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 80px' }}>
                <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {transcriptBlocks(runState, () => setRunState('done'), () => setRunState('failed'), followStream, job)}
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

            <RightRail runState={runState} cost={cost} tokens={tokens} elapsed={`${mm}:${ss}`} onPause={() => setRunState('gate')} onCancel={() => { if (job) void api.cancelJob(job.id).catch(() => {}); setRunState('failed'); }} />
          </div>
        </div>
      </AppShell>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
