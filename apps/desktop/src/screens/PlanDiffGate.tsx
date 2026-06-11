/* Plan & Diff Gate — the human approval gate for an agent's plan (Mode A) and
   its proposed diff (Mode B, with a GPT reviewer findings rail).
   Ported from the Babel-standalone prototype (design/project/plan-diff-gate/*.jsx)
   to an ES-module TypeScript React screen. Visual output is unchanged:
   inline styles, classNames, var(--…) variables, SVG and animation class names
   are all preserved. Cross-page location.href navigation is replaced with
   react-router useNavigate(). */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, OpenAIGlyph, type IconName } from '../lib/icons';
import { Spinner } from '../lib/ui';
import { AppShell } from '../lib/appShell';
import { api, type Approval, type Project } from '../lib/api';

/* ────────────────────────────────────────────────────────────────────────
   Page-specific CSS (from "Plan Diff Gate.html" <style>), rendered as a
   <style> element so hover/animation classNames keep working.
   ──────────────────────────────────────────────────────────────────────── */

const styles = `
  /* diff line backgrounds */
  :root, [data-theme="light"] { --diff-add: #E8F8EE; --diff-del: #FDEBEC; }
  [data-theme="dark"] { --diff-add: rgba(52,199,89,0.15); --diff-del: rgba(255,59,48,0.14); }

  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.45); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .reject-btn:hover { background: rgba(255,59,48,0.1); }
  .file-row:hover { background: var(--fill-tertiary); }

  /* diff line flash on jump */
  .line-flash { animation: lineFlash 1.2s ease; }
  @keyframes lineFlash { 0%, 100% { box-shadow: inset 0 0 0 0 rgba(0,122,255,0); } 25% { box-shadow: inset 3px 0 0 0 var(--blue), inset 0 0 0 100px rgba(0,122,255,0.10); } }

  /* findings green sweep + strike on resolve */
  .finding.sweeping .fixed-sweep { animation: sweep 700ms ease forwards; }
  @keyframes sweep { to { transform: translateX(100%); } }
  .finding-fixed .finding-text { color: var(--ink-tertiary); text-decoration: line-through; text-decoration-color: var(--green); }

  /* approve check-pop — frozen-clock-safe (scale only, base visible) */
  .checkpop { animation: popFade 200ms ease; }
  @keyframes popFade { from { opacity: 0.4; } to { opacity: 1; } }
  .checkpop-circle { animation: checkPop 420ms var(--spring); }
  @keyframes checkPop { 0% { transform: scale(0.5); } 60% { transform: scale(1.12); } 100% { transform: scale(1); } }

  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

/* ────────────────────────────────────────────────────────────────────────
   Mode A: Plan gate (pg-plan.jsx)
   ──────────────────────────────────────────────────────────────────────── */

interface PlanStep {
  title: string;
  detail: string;
}

const PLAN_STEPS: PlanStep[] = [
  { title: 'Add a reversible migration', detail: 'Create migrations/0042 adding a nullable jwt_id column and an index. Backfill is a no-op; the column stays empty until tokens are issued.' },
  { title: 'Issue short-lived JWTs on login', detail: 'In routes/login.ts, sign a 15-minute token carrying the session id and set it alongside the existing cookie. Nothing is removed yet.' },
  { title: 'Read token-first with cookie fallback', detail: 'Update the three call sites that read req.session so they verify a bearer token first and fall back to the legacy cookie only when absent.' },
  { title: 'Add coverage', detail: 'Unit tests for token issue/verify/expiry and an integration test proving an existing cookie session keeps working through the rollout.' },
  { title: 'Open a PR behind the merge gate', detail: 'Summarize the change in plain language, link the issue, and stop at the gate — nothing merges without your approval.' },
];

function PlanGate({ editing, subtitle }: { editing: boolean; subtitle?: string }) {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* plan card */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 22px', borderBottom: '0.5px solid var(--separator)' }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)', flexShrink: 0 }}>
            <Icon name="sliders" size={20} />
          </span>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Plan</h1>
            <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>{subtitle ?? 'Refactor auth service to short-lived JWTs'}</div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
            background: 'color-mix(in srgb, var(--orange) 14%, transparent)', color: 'var(--orange)', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em' }}>
            <Icon name="gauge" size={12} /> PLANNED AT DEEP
          </span>
        </div>

        {/* steps */}
        <div style={{ padding: '8px 0' }}>
          {PLAN_STEPS.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 14, padding: '14px 22px', borderBottom: i < PLAN_STEPS.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
              <span style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', marginTop: 1,
                background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-footnote)/1 var(--font-mono)' }}>{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editing
                  ? <input defaultValue={s.title} style={{ width: '100%', border: 'none', outline: 'none', background: 'var(--fill-tertiary)', borderRadius: 7, padding: '6px 10px',
                      font: '600 var(--fs-headline)/1.3 var(--font-text)', color: 'var(--ink)', marginBottom: 6 }} />
                  : <div style={{ font: '600 var(--fs-headline)/1.3 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)', marginBottom: 4 }}>{s.title}</div>}
                <div style={{ font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>{s.detail}</div>
              </div>
            </div>
          ))}
        </div>

        {/* footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 22px', background: 'var(--fill-tertiary)', borderTop: '0.5px solid var(--separator)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>
            <Icon name="spark" size={15} style={{ color: 'var(--purple)' }} /> ≈ $0.60 · ~6 min
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>5 steps · 2 files touched · 1 migration</span>
        </div>
      </div>

      {editing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', borderRadius: 10, background: 'color-mix(in srgb, var(--blue) 8%, transparent)', border: '0.5px solid color-mix(in srgb, var(--blue) 22%, transparent)' }}>
          <Icon name="sliders" size={15} style={{ color: 'var(--blue)' }} />
          <span style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>Editing the plan. Your changes are sent back to the agent when you approve.</span>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Mode B: diff data, file tree, diff viewer (pg-diff.jsx)
   ──────────────────────────────────────────────────────────────────────── */

interface FileEntry {
  path: string;
  add: number;
  del: number;
  lang: string;
  active?: boolean;
  isNew?: boolean;
}

const FILES: FileEntry[] = [
  { path: 'src/auth/session.ts', add: 24, del: 8, lang: 'TS', active: true },
  { path: 'src/auth/jwt.ts', add: 40, del: 0, lang: 'TS', isNew: true },
  { path: 'src/routes/login.ts', add: 12, del: 5, lang: 'TS' },
  { path: 'migrations/0042_add_jwt_id.sql', add: 18, del: 0, lang: 'SQL', isNew: true },
  { path: 'test/auth/jwt.test.ts', add: 56, del: 0, lang: 'TS', isNew: true },
];

type DiffLineType = 'hunk' | 'ctx' | 'add' | 'del';

interface DiffLine {
  type: DiffLineType;
  o?: number | null;
  n?: number | null;
  c: string;
}

// diff for session.ts — {type: ctx|add|del, o: oldNo, n: newNo, c: code}
const DIFF: DiffLine[] = [
  { type: 'hunk', c: '@@ -1,9 +1,25 @@ auth/session.ts' },
  { type: 'ctx', o: 1, n: 1, c: "import { store } from '../db';" },
  { type: 'add', o: null, n: 2, c: "import { verifyJwt } from './jwt';" },
  { type: 'ctx', o: 2, n: 3, c: '' },
  { type: 'ctx', o: 3, n: 4, c: 'export async function getSession(req) {' },
  { type: 'del', o: 4, n: null, c: "  const sid = req.cookies['sid'];" },
  { type: 'del', o: 5, n: null, c: '  return store.get(sid);' },
  { type: 'add', o: null, n: 5, c: '  const bearer = req.headers.authorization?.slice(7);' },
  { type: 'add', o: null, n: 6, c: '  if (bearer) {' },
  { type: 'add', o: null, n: 7, c: '    const claims = verifyJwt(bearer);' },
  { type: 'add', o: null, n: 8, c: '    if (claims) return store.get(claims.sid);' },
  { type: 'add', o: null, n: 9, c: '  }' },
  { type: 'add', o: null, n: 10, c: '  // legacy cookie fallback during rollout' },
  { type: 'add', o: null, n: 11, c: "  const sid = req.cookies['sid'];" },
  { type: 'add', o: null, n: 12, c: '  return store.get(sid);' },
  { type: 'ctx', o: 6, n: 13, c: '}' },
  { type: 'ctx', o: 7, n: 14, c: '' },
  { type: 'del', o: 8, n: null, c: 'export function clearSession(sid) {' },
  { type: 'add', o: null, n: 15, c: 'export function clearSession(sid: string) {' },
  { type: 'ctx', o: 9, n: 16, c: '  return store.del(sid);' },
];

function FileTree({ files, active, onPick }: { files: FileEntry[]; active: number; onPick: (i: number) => void }) {
  return (
    <aside style={{ width: 240, flexShrink: 0, borderRight: '0.5px solid var(--separator)', padding: '16px 12px', overflowY: 'auto',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px 12px' }}>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Changed files</span>
        <span style={{ flex: 1 }} />
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{files.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {files.map((f, i) => {
          const on = active === i;
          const parts = f.path.split('/'); const name = parts.pop(); const dir = parts.join('/') + '/';
          return (
            <button key={i} onClick={() => onPick(i)} className="file-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px', borderRadius: 8, textAlign: 'left',
              background: on ? 'var(--fill-secondary)' : 'transparent' }}>
              <Icon name="terminal" size={14} style={{ color: on ? 'var(--blue)' : 'var(--ink-tertiary)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.2 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>{name}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1.1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dir}{f.isNew ? ' · new' : ''}</span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0, lineHeight: 1.1 }}>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--green)' }}>+{f.add}</span>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--red)' }}>−{f.del}</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function DiffViewer({ mode }: { mode: string }) {
  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--bg-elevated)' }} className="diff-scroll">
      {/* sticky file header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px',
        background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '0.5px solid var(--separator)' }}>
        <Icon name="terminal" size={15} style={{ color: 'var(--ink-secondary)' }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>src/auth/session.ts</span>
        <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)', font: '600 var(--fs-caption)/18px var(--font-text)' }}>TypeScript</span>
        <span style={{ flex: 1 }} />
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--green)' }}>+24</span>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--red)' }}>−8</span>
      </div>

      {mode === 'unified' ? <UnifiedDiff /> : <SplitDiff />}
    </div>
  );
}

function gutter(no?: number | null) {
  return <span style={{ display: 'inline-block', width: 38, flexShrink: 0, textAlign: 'right', paddingRight: 10, color: 'var(--ink-tertiary)',
    font: '400 12px/20px var(--font-mono)', userSelect: 'none' }}>{no ?? ''}</span>;
}

function UnifiedDiff() {
  return (
    <div style={{ font: '400 13px/20px var(--font-mono)', paddingBottom: 20 }}>
      {DIFF.map((l, i) => {
        if (l.type === 'hunk') return (
          <div key={i} style={{ padding: '6px 12px', background: 'var(--fill-tertiary)', color: 'var(--ink-tertiary)', font: '500 12px/1.4 var(--font-mono)', borderBottom: '0.5px solid var(--separator)' }} id="finding-anchor-top">{l.c}</div>
        );
        const isAdd = l.type === 'add', isDel = l.type === 'del';
        return (
          <div key={i} data-line={l.n ?? undefined} style={{ display: 'flex', alignItems: 'stretch',
            background: isAdd ? 'var(--diff-add)' : isDel ? 'var(--diff-del)' : 'transparent' }}>
            {gutter(l.o)}{gutter(l.n)}
            <span style={{ width: 16, flexShrink: 0, textAlign: 'center', color: isAdd ? 'var(--green)' : isDel ? 'var(--red)' : 'var(--ink-tertiary)' }}>{isAdd ? '+' : isDel ? '−' : ''}</span>
            <span style={{ flex: 1, whiteSpace: 'pre', paddingRight: 16, color: 'var(--ink)' }}>{l.c || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

function SplitDiff() {
  // build paired rows: ctx → both; del → left; add → right
  const left: DiffLine[] = [], right: DiffLine[] = [];
  DIFF.filter(l => l.type !== 'hunk').forEach(l => {
    if (l.type === 'ctx') { left.push(l); right.push(l); }
    else if (l.type === 'del') left.push(l);
    else right.push(l);
  });
  const rows = Math.max(left.length, right.length);
  const col = (l: DiffLine | undefined, side: string) => {
    if (!l) return <div style={{ flex: 1, minWidth: 0, background: side === 'l' ? 'transparent' : 'transparent' }} />;
    const isAdd = l.type === 'add', isDel = l.type === 'del';
    return (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', background: isAdd ? 'var(--diff-add)' : isDel ? 'var(--diff-del)' : 'transparent', borderRight: side === 'l' ? '0.5px solid var(--separator)' : 'none' }}>
        {gutter(side === 'l' ? l.o : l.n)}
        <span style={{ flex: 1, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 10, color: 'var(--ink)' }}>{l.c || ' '}</span>
      </div>
    );
  };
  return (
    <div style={{ font: '400 12.5px/20px var(--font-mono)', paddingBottom: 20 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex' }}>{col(left[i], 'l')}{col(right[i], 'r')}</div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Findings rail + action bars (pg-app.jsx)
   ──────────────────────────────────────────────────────────────────────── */

type Severity = 'red' | 'amber' | 'grey';

interface Finding {
  id: string;
  sev: Severity;
  text: string;
  line: number;
  state: 'open' | 'fixed';
}

const FINDINGS_INIT: Finding[] = [
  { id: 'f1', sev: 'red',   text: 'Bearer parsing assumes a "Bearer " prefix — a malformed Authorization header will throw before the fallback runs.', line: 5, state: 'open' },
  { id: 'f2', sev: 'amber', text: 'Legacy cookie fallback has no expiry check; stale sessions persist until the cookie is cleared.', line: 11, state: 'open' },
  { id: 'f3', sev: 'grey',  text: 'clearSession is now explicitly typed (sid: string). Good catch on the loose param.', line: 15, state: 'fixed' },
];
const SEV: Record<Severity, string> = { red: 'var(--red)', amber: 'var(--orange)', grey: 'var(--ink-tertiary)' };

function FindingsRail({ findings, onJump }: { findings: Finding[]; onJump: (line: number) => void; onRequestFixes: () => void }) {
  const open = findings.filter(f => f.state === 'open').length;
  return (
    <aside style={{ width: 320, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ padding: '16px 18px', borderBottom: '0.5px solid var(--separator)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ width: 24, height: 24, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}><OpenAIGlyph size={15} /></span>
          <span style={{ flex: 1, font: '600 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)' }}>Review · GPT reviewer<br/><span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>pass 2 of 2</span></span>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 12px', borderRadius: 'var(--r-pill)',
          background: open > 0 ? 'rgba(255,149,0,0.14)' : 'rgba(52,199,89,0.16)', color: open > 0 ? 'var(--orange)' : 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
          {open > 0 ? <Icon name="alert" size={13} /> : <Icon name="check" size={13} stroke={2.6} />}
          {open > 0 ? `${open} issue${open > 1 ? 's' : ''} remaining` : 'All clear'}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {findings.map(f => {
          const fixed = f.state === 'fixed';
          return (
            <div key={f.id} className={`finding ${fixed ? 'finding-fixed' : ''}`} style={{ position: 'relative', background: 'var(--bg-elevated)', borderRadius: 12,
              border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 13, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: 5, background: SEV[f.sev], flexShrink: 0 }} />
                <span style={{ flex: 1, font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: SEV[f.sev] }}>{f.sev === 'red' ? 'Blocking' : f.sev === 'amber' ? 'Warning' : 'Note'}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)',
                  background: fixed ? 'rgba(52,199,89,0.16)' : 'var(--fill-secondary)', color: fixed ? 'var(--green)' : 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
                  {fixed ? <><Icon name="check" size={10} stroke={3} /> Fixed in loop</> : 'Open'}
                </span>
              </div>
              <div className="finding-text" style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty', marginBottom: 9 }}>{f.text}</div>
              <button onClick={() => onJump(f.line)} className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--blue)' }}>
                <Icon name="arrowRight" size={12} /> Jump to line {f.line}
              </button>
              <span className="fixed-sweep" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, transparent, rgba(52,199,89,0.18), transparent)', transform: 'translateX(-100%)', pointerEvents: 'none' }} />
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ── action bars ── */
function ActionBar({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 24px',
      background: 'var(--glass-tint)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      borderTop: '0.5px solid var(--separator)' }}>{children}</div>
  );
}
function GhostBtn({ icon, children, onClick, danger }: { icon?: IconName; children?: React.ReactNode; onClick?: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={danger ? 'reject-btn' : 'ghost-btn'} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 42, padding: '0 16px', borderRadius: 'var(--r-pill)',
      background: danger ? 'transparent' : 'var(--fill-secondary)', color: danger ? 'var(--red)' : 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
      {icon && <Icon name={icon} size={16} />}{children}
    </button>
  );
}
function PrimaryBtn({ icon, children, onClick }: { icon: IconName; children?: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 42, padding: '0 22px', borderRadius: 'var(--r-pill)',
      background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)' }}>
      <Icon name={icon} size={17} />{children}
    </button>
  );
}

function RespondField({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ flexShrink: 0, padding: '14px 24px', borderTop: '0.5px solid var(--separator)', background: 'var(--bg-elevated)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div style={{ flex: 1, background: 'var(--fill-tertiary)', borderRadius: 12, border: '0.5px solid var(--separator)', padding: '10px 14px' }}>
          <textarea autoFocus rows={2} placeholder="Reply to the agent — ask a question or steer the plan…" style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', resize: 'none',
            font: '400 var(--fs-callout)/1.5 var(--font-text)', color: 'var(--ink)' }} />
        </div>
        <button onClick={onClose} className="primary-cta" style={{ width: 42, height: 42, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--blue)', color: '#fff', boxShadow: '0 6px 16px rgba(0,122,255,0.34)' }}>
          <Icon name="arrowRight" size={19} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>
    </div>
  );
}

function CheckPop({ label }: { label: string }) {
  return (
    <div className="checkpop" style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'grid', placeItems: 'center',
      background: 'color-mix(in srgb, var(--bg) 70%, transparent)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}>
      <div style={{ textAlign: 'center' }}>
        <span className="checkpop-circle" style={{ display: 'inline-grid', placeItems: 'center', width: 72, height: 72, borderRadius: '50%', background: 'var(--green)', color: '#fff', marginBottom: 16, boxShadow: '0 12px 36px rgba(52,199,89,0.42)' }}>
          <Icon name="check" size={38} stroke={3} />
        </span>
        <div style={{ font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Approved</div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, marginTop: 8, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
          <Spinner size={14} color="var(--purple)" /> {label}
        </div>
      </div>
    </div>
  );
}

function ResolvedOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(20,22,30,0.5)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}>
      <div onClick={e => e.stopPropagation()} className="sheet-pop" style={{ width: 420, textAlign: 'center', background: 'var(--bg-elevated)', borderRadius: 18,
        border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: '28px 24px 22px' }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', marginBottom: 16 }}>
          <Icon name="smartphone" size={26} />
        </span>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Already approved</h2>
        <p style={{ margin: '0 0 6px', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>You approved this gate from your phone · 2 min ago. The job is already building.</p>
        <p style={{ margin: '0 0 20px', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
          <Icon name="shield" size={12} style={{ verticalAlign: '-1px', marginRight: 4 }} />Gate survived a restart — state is durable.
        </p>
        <button onClick={onClose} className="primary-cta" style={{ height: 42, padding: '0 24px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Got it</button>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Command palette (from cc-palette.jsx) — inlined; not exported by shared lib.
   ──────────────────────────────────────────────────────────────────────── */

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

  const onKey = (e: React.KeyboardEvent) => {
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

/* ────────────────────────────────────────────────────────────────────────
   Page root (pg-app.jsx GateApp). The prototype wrapped everything in
   WindowFrame + Sidebar + Toolbar; that chrome is now the shared AppShell.
   ──────────────────────────────────────────────────────────────────────── */

export default function PlanDiffGate() {
  const navigate = useNavigate();
  const [mode, setMode] = React.useState<'plan' | 'diff'>('plan');
  const [diffView, setDiffView] = React.useState('unified');
  const [editing, setEditing] = React.useState(false);
  const [responding, setResponding] = React.useState(false);
  const [findings, setFindings] = React.useState<Finding[]>(FINDINGS_INIT);
  const [resolved, setResolved] = React.useState(false);
  const [approved, setApproved] = React.useState<null | 'building' | 'merging'>(null);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // Live gate under review: the pending 'merge' approval (else first pending),
  // plus the project it belongs to. Falls back to the static prototype copy
  // when nothing is loaded yet so the layout renders identically while empty.
  const [gate, setGate] = React.useState<Approval | null>(null);
  const [project, setProject] = React.useState<Project | null>(null);

  const loadGate = React.useCallback(async () => {
    try {
      const [approvals, projects] = await Promise.all([api.listApprovals('pending'), api.listProjects()]);
      const picked = approvals.find(a => a.kind === 'merge') ?? approvals[0] ?? null;
      setGate(picked);
      const proj = picked ? projects.find(p => p.id === picked.projectId) ?? null : null;
      setProject(proj);
    } catch {
      // fail-soft: keep prototype defaults; never throw in render
    }
  }, []);

  React.useEffect(() => { void loadGate(); }, [loadGate]);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  // Derived header copy — live gate values when present, else original strings.
  const projectName = project?.name ?? 'Atlas API';
  const gateTitle = gate?.title ?? 'Refactor auth service';
  const gateSubtitle = gate?.detail ?? gate?.subtitle ?? 'Refactor auth service to short-lived JWTs';

  const jumpToLine = (n: number) => { const el = document.querySelector(`[data-line="${n}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el && el.classList.add('line-flash'); setTimeout(() => el && el.classList.remove('line-flash'), 1200); };

  const requestFixes = () => {
    document.querySelectorAll('.finding').forEach(f => f.classList.add('sweeping'));
    setTimeout(() => setFindings(fs => fs.map(f => ({ ...f, state: 'fixed' }))), 700);
  };

  const approve = () => {
    setApproved(mode === 'plan' ? 'building' : 'merging');
    if (gate) {
      void (async () => {
        try { await api.approveApproval(gate.id); await loadGate(); }
        catch { /* fail-soft: overlay already shown */ }
      })();
    }
  };

  const reject = () => {
    if (gate) {
      void (async () => {
        try { await api.denyApproval(gate.id); }
        catch { /* fail-soft */ }
        finally { await loadGate(); setResolved(true); }
      })();
    } else {
      setResolved(true);
    }
  };

  return (
    <AppShell active="approvals" onSearch={() => setPaletteOpen(true)}>
      <style>{styles}</style>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', position: 'relative', zIndex: 1 }}>
        {/* job header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 24px', borderBottom: '0.5px solid var(--separator)', position: 'relative', zIndex: 5,
          background: 'color-mix(in srgb, var(--bg) 86%, transparent)' }}>
          <button onClick={() => navigate('/job-monitor')} className="ghost-btn" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink)', flexShrink: 0 }}><Icon name="arrowLeft" size={17} /></button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 4 }}>
              <span>{projectName}</span><Icon name="chevronRight" size={12} style={{ color: 'var(--ink-tertiary)' }} /><span style={{ color: 'var(--ink)', fontWeight: 600 }}>{gateTitle}</span>
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
              background: 'color-mix(in srgb, var(--orange) 15%, transparent)', color: 'var(--orange)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
              <Icon name="enter" size={13} /> Waiting at gate · 12 min
            </span>
          </div>
          <div style={{ display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
            {([['plan', 'Plan gate'], ['diff', 'Diff gate']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setMode(k)} style={{ padding: '7px 14px', borderRadius: 7, font: '600 var(--fs-footnote)/1 var(--font-text)',
                background: mode === k ? 'var(--bg-elevated)' : 'transparent', color: mode === k ? 'var(--ink)' : 'var(--ink-secondary)',
                boxShadow: mode === k ? '0 1px 3px rgba(0,0,0,0.14)' : 'none', transition: 'all 160ms ease' }}>{label}</button>
            ))}
          </div>
          <button onClick={() => setResolved(true)} className="tb-icon" title="Simulate approval from phone" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}>
            <Icon name="smartphone" size={18} />
          </button>
        </div>

        {/* body */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
          {mode === 'plan' ? (
            <React.Fragment>
              <div style={{ flex: 1, overflowY: 'auto', padding: '28px 24px 28px' }}><PlanGate editing={editing} subtitle={gateSubtitle} /></div>
              {responding && <RespondField onClose={() => setResponding(false)} />}
              <ActionBar>
                <PrimaryBtn icon="check" onClick={approve}>Approve &amp; build</PrimaryBtn>
                <GhostBtn icon="sliders" onClick={() => setEditing(e => !e)}>{editing ? 'Done editing' : 'Edit plan'}</GhostBtn>
                <GhostBtn icon="command" onClick={() => setResponding(r => !r)}>Respond</GhostBtn>
                <span style={{ flex: 1 }} />
                <GhostBtn danger onClick={reject}>Reject</GhostBtn>
              </ActionBar>
            </React.Fragment>
          ) : (
            <React.Fragment>
              <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
                <FileTree files={FILES} active={0} onPick={() => {}} />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '0.5px solid var(--separator)', background: 'var(--bg-elevated)' }}>
                    <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>3 of 5 files reviewed</span>
                    <span style={{ flex: 1 }} />
                    <div style={{ display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 8 }}>
                      {([['unified', 'Unified'], ['split', 'Side-by-side']] as const).map(([k, label]) => (
                        <button key={k} onClick={() => setDiffView(k)} style={{ padding: '5px 11px', borderRadius: 6, font: '600 var(--fs-caption)/1 var(--font-text)',
                          background: diffView === k ? 'var(--bg-elevated)' : 'transparent', color: diffView === k ? 'var(--ink)' : 'var(--ink-secondary)',
                          boxShadow: diffView === k ? '0 1px 2px rgba(0,0,0,0.14)' : 'none' }}>{label}</button>
                      ))}
                    </div>
                  </div>
                  <DiffViewer mode={diffView} />
                </div>
                <FindingsRail findings={findings} onJump={jumpToLine} onRequestFixes={requestFixes} />
              </div>
              <ActionBar>
                <PrimaryBtn icon="gitMerge" onClick={approve}>Approve &amp; merge to PR</PrimaryBtn>
                <GhostBtn icon="refresh" onClick={requestFixes}>Request fixes</GhostBtn>
                <GhostBtn danger onClick={reject}>Reject</GhostBtn>
                <span style={{ flex: 1 }} />
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)',
                  background: 'rgba(52,199,89,0.13)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                  <Icon name="shield" size={14} /> Judge panel: 3/3 approve
                </span>
              </ActionBar>
            </React.Fragment>
          )}

          {/* approve check-pop */}
          {approved && <CheckPop label={approved === 'building' ? 'Building…' : 'Merging to PR…'} />}
          {/* resolved elsewhere */}
          {resolved && <ResolvedOverlay onClose={() => setResolved(false)} />}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
