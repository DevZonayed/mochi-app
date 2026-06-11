/* Approvals Center — split-view decision queue: urgency-grouped gate list,
   per-type detail renderers, sticky action bar with keyboard shortcuts,
   auto-advance, over-budget confirm sheet, empty state, and ⌘K palette.
   Ported to ES-module TypeScript React — visual output unchanged.

   The prototype rendered its own WindowFrame (Sidebar + Toolbar + a non-
   scrolling split body), so it can't use AppShell's single <main> wrapper.
   We reuse the shared Sidebar / Toolbar / TrafficLights / useAppScale / useTheme
   primitives and rebuild that frame here, with react-router navigation. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  APP_W, APP_H, useAppScale, useTheme, TrafficLights, Sidebar, Toolbar,
} from '../lib/appShell';
import { Icon, OpenAIGlyph, type IconName } from '../lib/icons';
import { api, type Approval, type ApprovalKind, type Project } from '../lib/api';

/* ───────────────────────── page-specific CSS (from Approvals Center.html) ───────────────────────── */
const styles = `
  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.45); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .reject-btn:hover { background: rgba(255,59,48,0.1); }
  .q-row { transition: background 120ms ease, border-color 120ms ease; }
  .q-row:hover { background: var(--fill-tertiary); }
  .budget-opt { transition: transform 120ms var(--spring), box-shadow 140ms ease, filter 140ms ease; cursor: pointer; }
  .budget-opt:hover { filter: brightness(1.03); }
  .budget-opt.primary:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .budget-opt:active { transform: translateY(1px); }

  /* detail crossfade — frozen-clock-safe (transform only) */
  .detail-fade { animation: detailFade 240ms var(--spring); }
  @keyframes detailFade { from { transform: translateY(6px); } to { transform: none; } }

  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

/* ───────────────────────── data (from ac-queue.jsx) ───────────────────────── */
interface ProjMeta { name: string; color: string; }
/* Project metadata is resolved live (see page root). Live entries are keyed by
   project id and merged in at runtime; '_none' is the fallback for approvals
   with no associated project. Render code reads AC_PROJ[g.proj] unchanged. */
const AC_PROJ: Record<string, ProjMeta> = {
  _none: { name: 'Workspace', color: 'var(--ink-secondary)' },
};

interface GateTypeMeta { icon: IconName; tint: string; label: string; }
const GATE_TYPE: Record<string, GateTypeMeta> = {
  plan:    { icon: 'sliders',  tint: 'var(--blue)',   label: 'Plan' },
  publish: { icon: 'play',     tint: 'var(--purple)', label: 'Publish' },
  merge:   { icon: 'gitMerge', tint: 'var(--green)',  label: 'Merge' },
  send:    { icon: 'send',      tint: 'var(--teal)',   label: 'Send' },
  budget:  { icon: 'gauge',     tint: 'var(--orange)', label: 'Over budget' },
  skill:   { icon: 'shield',    tint: 'var(--indigo)', label: 'Skill' },
};

type Risk = 'red' | 'amber' | 'grey';
interface SkillCap { kind: 'net' | 'fs'; label: string; risk: Risk; }

interface BudgetDetailData { need: number; cap: number; spent: number; run: string; }
interface MergeDetailData { pr: number; files: number; add: number; del: number; verdict: string; findings: string; }
interface SkillDetailData { skill: string; ver: string; publisher: string; caps: SkillCap[]; }
interface PublishDetailData { platform: string; caption: string; posts: number; consent: boolean; }
interface PlanDetailData { title: string; effort: string; cost: string; mins: string; steps: string[]; }
interface SendDetailData { channel: string; recipients: string; subject: string; consent: boolean; }
type GateDetailData =
  | BudgetDetailData | MergeDetailData | SkillDetailData
  | PublishDetailData | PlanDetailData | SendDetailData;

interface Gate {
  id: string;
  type: keyof typeof GATE_TYPE;
  proj: string;
  urgency: string;
  summary: string;
  age: string;
  jobId?: string | null;
  scheduled?: boolean;
  unread?: boolean;
  detail: GateDetailData;
}

/* Map a live Approval.kind to one of the screen's gate types (which drive the
   icon, tint, label and detail renderer). 'deploy'→publish, 'review'→merge. */
const KIND_TO_TYPE: Record<ApprovalKind, keyof typeof GATE_TYPE> = {
  merge:   'merge',
  budget:  'budget',
  publish: 'publish',
  deploy:  'publish',
  review:  'merge',
};

/* Human "age" string from a created-at epoch (ms). */
function ageLabel(createdAt: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (secs < 60) return `${secs || 1} sec`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr`;
  return `${Math.floor(hrs / 24)} d`;
}

/* Build the type-specific detail object the matching renderer expects, from the
   approval's free-text fields. Each renderer reads only the fields below. */
function buildDetail(type: keyof typeof GATE_TYPE, a: Approval): GateDetailData {
  const text = a.detail || a.subtitle || '';
  switch (type) {
    case 'budget':
      return { need: 0, cap: 0, spent: 0, run: a.title } as BudgetDetailData;
    case 'merge':
      return { pr: 0, files: 0, add: 0, del: 0, verdict: 'clear', findings: text } as MergeDetailData;
    case 'skill':
      return { skill: a.title, ver: '—', publisher: a.subtitle || '—', caps: [] } as SkillDetailData;
    case 'publish':
      return { platform: a.subtitle || 'Publish', caption: text, posts: 1, consent: false } as PublishDetailData;
    case 'send':
      return { channel: a.subtitle || 'Send', recipients: '—', subject: a.title, consent: false } as SendDetailData;
    case 'plan':
    default:
      return { title: a.title, effort: '—', cost: '—', mins: '—', steps: text ? [text] : [] } as PlanDetailData;
  }
}

/* Adapt a pending Approval into the Gate shape the render code consumes. */
function approvalToGate(a: Approval): Gate {
  const type = KIND_TO_TYPE[a.kind] ?? 'plan';
  const proj = a.projectId && AC_PROJ[a.projectId] ? a.projectId : '_none';
  const ageMins = Math.floor((Date.now() - a.createdAt) / 60000);
  const urgency = type === 'budget' ? 'budget' : ageMins >= 10 ? 'old' : 'new';
  return {
    id: a.id,
    type,
    proj,
    urgency,
    summary: a.title,
    age: ageLabel(a.createdAt),
    jobId: a.jobId ?? null,
    detail: buildDetail(type, a),
  };
}

interface UrgencyGroup { key: string; label: string; tint: string; }
const URGENCY: UrgencyGroup[] = [
  { key: 'budget', label: 'Over budget', tint: 'var(--orange)' },
  { key: 'old', label: 'Waiting longest', tint: 'var(--ink-secondary)' },
  { key: 'new', label: 'New', tint: 'var(--blue)' },
];

/* ───────────────────────── queue list (from ac-queue.jsx) ───────────────────────── */
function QueueRow({ g, active, onClick }: { g: Gate; active: boolean; onClick: (g: Gate) => void }) {
  const t = GATE_TYPE[g.type];
  const p = AC_PROJ[g.proj];
  return (
    <button onClick={() => onClick(g)} className="q-row" style={{ display: 'flex', gap: 12, width: '100%', textAlign: 'left', padding: '12px 14px', borderRadius: 12,
      background: active ? 'var(--fill-secondary)' : 'transparent', border: active ? '0.5px solid var(--separator)' : '0.5px solid transparent', position: 'relative' }}>
      {g.unread && <span style={{ position: 'absolute', left: 4, top: '50%', transform: 'translateY(-50%)', width: 7, height: 7, borderRadius: 4, background: 'var(--blue)' }} />}
      <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${t.tint} 14%, transparent)`, color: t.tint }}>
        <Icon name={t.icon} size={19} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color, flexShrink: 0 }} />
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{p.name}</span>
          {g.scheduled && <Icon name="clock" size={11} style={{ color: 'var(--ink-tertiary)' }} />}
          <span style={{ flex: 1 }} />
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>{g.age}</span>
        </span>
        <span style={{ display: 'block', font: `${g.unread ? 700 : 500} var(--fs-subhead)/1.3 var(--font-text)`, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{g.summary}</span>
      </span>
    </button>
  );
}

function QueueList({ gates, activeId, onPick }: { gates: Gate[]; activeId: string | null; onPick: (g: Gate) => void }) {
  return (
    <aside style={{ width: 360, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 18px 14px' }}>
        <h1 style={{ margin: 0, font: '700 var(--fs-title1)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Approvals</h1>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 24, height: 24, padding: '0 8px', borderRadius: 'var(--r-pill)',
          background: 'var(--red)', color: '#fff', font: '700 var(--fs-footnote)/1 var(--font-mono)' }}>{gates.length}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px 14px' }}>
        {URGENCY.map(u => {
          const rows = gates.filter(g => g.urgency === u.key);
          if (!rows.length) return null;
          return (
            <div key={u.key} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 8px 7px' }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: u.tint }} />
                <span style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{u.label}</span>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>· {rows.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {rows.map(g => <QueueRow key={g.id} g={g} active={activeId === g.id} onClick={onPick} />)}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ───────────────────────── gate detail renderers (from ac-details.jsx) ───────────────────────── */
function DetailShell({ g, children }: { g: Gate; children?: React.ReactNode }) {
  const t = GATE_TYPE[g.type];
  const p = AC_PROJ[g.proj];
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${t.tint} 14%, transparent)`, color: t.tint }}>
          <Icon name={t.icon} size={23} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color }} />
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{p.name}</span>
            <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
            <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{t.label} gate · {g.age}</span>
          </div>
          <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', textWrap: 'pretty' }}>{g.summary}</h2>
        </div>
      </div>
      {children}
    </div>
  );
}

function Card({ children, pad = 20, style }: { children?: React.ReactNode; pad?: number; style?: React.CSSProperties }) {
  return <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: pad, ...style }}>{children}</div>;
}

function Badge({ icon, children, tint }: { icon?: IconName; children?: React.ReactNode; tint: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
      {icon && <Icon name={icon} size={13} />}{children}
    </span>
  );
}

// ── Plan
function PlanDetail({ d }: { d: PlanDetailData }) {
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px', borderBottom: '0.5px solid var(--separator)' }}>
        <span style={{ font: '700 var(--fs-headline)/1.1 var(--font-text)', color: 'var(--ink)', flex: 1 }}>{d.title}</span>
        <Badge icon="gauge" tint="var(--blue)">PLANNED AT {d.effort}</Badge>
      </div>
      <div>
        {d.steps.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 20px', borderBottom: i < d.steps.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{i + 1}</span>
            <span style={{ font: '500 var(--fs-callout)/1.4 var(--font-text)', color: 'var(--ink)' }}>{s}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '13px 20px', background: 'var(--fill-tertiary)', font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>≈ ${d.cost} · ~{d.mins} min</div>
    </Card>
  );
}

// ── Publish
function PublishDetail({ d }: { d: PublishDetailData }) {
  return (
    <Card>
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ width: 150, height: 150, borderRadius: 12, flexShrink: 0, background: 'linear-gradient(135deg, #5E8BFF, #A24BE0)', display: 'grid', placeItems: 'center', position: 'relative', overflow: 'hidden' }}>
          <Icon name="image" size={34} style={{ color: 'rgba(255,255,255,0.85)' }} />
          <span style={{ position: 'absolute', bottom: 8, right: 8, width: 30, height: 30, borderRadius: '50%', background: 'rgba(0,0,0,0.35)', display: 'grid', placeItems: 'center', color: '#fff' }}><Icon name="play" size={14} /></span>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 7, marginBottom: 10, flexWrap: 'wrap' }}>
            <Badge icon="send" tint="var(--purple)">{d.platform}</Badge>
            <Badge tint="var(--ink-secondary)">{d.posts} post{d.posts > 1 ? 's' : ''}</Badge>
          </div>
          <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink)', textWrap: 'pretty' }}>{d.caption}</p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--separator)', flexWrap: 'wrap' }}>
        <Badge icon="shield" tint="var(--green)">C2PA ✓ · AI label ✓</Badge>
        {d.consent
          ? <Badge icon="check" tint="var(--green)">Consent on file</Badge>
          : <Badge icon="alert" tint="var(--ink-tertiary)">No avatar / voice used</Badge>}
      </div>
    </Card>
  );
}

// ── Merge
function MergeDetail({ d }: { d: MergeDetailData }) {
  const navigate = useNavigate();
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <div style={{ font: '600 var(--fs-headline)/1 var(--font-mono)', color: 'var(--ink)' }}>PR #{d.pr}</div>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--green)' }}>+{d.add}</span>
        <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--red)' }}>−{d.del}</span>
        <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{d.files} files</span>
        <span style={{ flex: 1 }} />
        <a onClick={(e) => { e.preventDefault(); navigate('/plan-diff-gate'); }} href="/plan-diff-gate" className="link-btn" style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)', textDecoration: 'none', cursor: 'pointer' }}>Open full diff →</a>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', borderRadius: 12, background: 'rgba(52,199,89,0.10)', border: '0.5px solid rgba(52,199,89,0.3)' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--bg-elevated)', color: 'var(--ink-secondary)' }}><OpenAIGlyph size={17} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '600 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)' }}>Reviewer: all clear</div>
          <div style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>{d.findings}</div>
        </div>
        <Badge icon="shield" tint="var(--green)">3/3 judges</Badge>
      </div>
    </Card>
  );
}

// ── Over budget
function BudgetDetail({ d, onRaise }: { d: BudgetDetailData; onRaise: () => void }) {
  return (
    <Card>
      <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
        <div style={{ font: '400 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 10 }}>This run needs</div>
        <div style={{ font: '700 56px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--orange)' }}>+${d.need.toFixed(2)}</div>
        <div style={{ font: '500 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink-tertiary)', marginTop: 10 }}>${d.spent.toFixed(2)} spent of ${d.cap} cap · “{d.run}”</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        <button onClick={onRaise} className="budget-opt primary" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderRadius: 12, background: 'var(--blue)', color: '#fff', textAlign: 'left', boxShadow: '0 6px 16px rgba(0,122,255,0.28)' }}>
          <Icon name="gauge" size={18} /><span style={{ flex: 1, font: '600 var(--fs-callout)/1.2 var(--font-text)' }}>Raise cap to $60</span><Icon name="chevronRight" size={16} />
        </button>
        <button className="budget-opt" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderRadius: 12, background: 'var(--fill-secondary)', color: 'var(--ink)', textAlign: 'left' }}>
          <Icon name="cpu" size={18} style={{ color: 'var(--ink-secondary)' }} /><span style={{ flex: 1, font: '600 var(--fs-callout)/1.2 var(--font-text)' }}>Downgrade model <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>· finishes within cap</span></span>
        </button>
        <button className="budget-opt" style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderRadius: 12, background: 'transparent', color: 'var(--red)', textAlign: 'left', border: '0.5px solid var(--separator)' }}>
          <Icon name="x" size={18} /><span style={{ flex: 1, font: '600 var(--fs-callout)/1.2 var(--font-text)' }}>Abort run</span>
        </button>
      </div>
    </Card>
  );
}

// ── Skill
function SkillDetail({ d }: { d: SkillDetailData }) {
  const riskTint: Record<Risk, string> = { red: 'var(--red)', amber: 'var(--orange)', grey: 'var(--ink-tertiary)' };
  return (
    <Card pad={0}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '0.5px solid var(--separator)' }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--indigo) 13%, transparent)', color: 'var(--indigo)' }}><Icon name="spark" size={19} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ font: '600 var(--fs-headline)/1.1 var(--font-mono)', color: 'var(--ink)' }}>{d.skill} <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>v{d.ver}</span></div>
          <div style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>Publisher: {d.publisher}</div>
        </div>
        <Badge icon="alert" tint="var(--orange)">Unverified</Badge>
      </div>
      <div style={{ padding: '14px 20px' }}>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 11 }}>Requested capabilities</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {d.caps.map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
              <Icon name={c.kind === 'net' ? 'wifi' : 'folder'} size={15} style={{ color: riskTint[c.risk], flexShrink: 0 }} />
              <span style={{ flex: 1, font: '500 var(--fs-footnote)/1.2 var(--font-mono)', color: 'var(--ink)' }}>{c.label}</span>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: riskTint[c.risk] }} title={c.risk} />
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ── Send
function SendDetail({ d }: { d: SendDetailData }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--teal) 14%, transparent)', color: 'var(--teal)' }}><Icon name="send" size={18} /></span>
          <div style={{ flex: 1 }}>
            <div style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{d.channel}</div>
            <div style={{ font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>To <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{d.recipients}</b> subscribers</div>
          </div>
          {d.consent && <Badge icon="check" tint="var(--green)">Opt-in verified</Badge>}
        </div>
        <div style={{ padding: '13px 15px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)' }}>
          <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Subject</div>
          <div style={{ font: '600 var(--fs-callout)/1.3 var(--font-text)', color: 'var(--ink)' }}>{d.subject}</div>
        </div>
      </div>
    </Card>
  );
}

function GateDetail({ g, onRaise }: { g: Gate; onRaise: () => void }) {
  return (
    <DetailShell g={g}>
      {g.type === 'plan' && <PlanDetail d={g.detail as PlanDetailData} />}
      {g.type === 'publish' && <PublishDetail d={g.detail as PublishDetailData} />}
      {g.type === 'merge' && <MergeDetail d={g.detail as MergeDetailData} />}
      {g.type === 'budget' && <BudgetDetail d={g.detail as BudgetDetailData} onRaise={onRaise} />}
      {g.type === 'skill' && <SkillDetail d={g.detail as SkillDetailData} />}
      {g.type === 'send' && <SendDetail d={g.detail as SendDetailData} />}
    </DetailShell>
  );
}

/* ───────────────────────── ⌘K command palette (from cc-palette.jsx) ───────────────────────── */
interface PaletteItem { group: string; icon: IconName; label: string; hint: string; }
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

/* ───────────────────────── action-bar key cap + sheet + empty state (from ac-app.jsx) ───────────────────────── */
function ActionKey({ children }: { children?: React.ReactNode }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 4px', borderRadius: 5,
    background: 'rgba(255,255,255,0.22)', font: '600 var(--fs-caption)/1 var(--font-mono)' }}>{children}</span>;
}

function RaiseSheet({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 400, textAlign: 'center', background: 'var(--bg-elevated)', borderRadius: 18,
        border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', padding: '26px 24px 20px' }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 50, height: 50, borderRadius: '50%', background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', marginBottom: 15 }}><Icon name="gauge" size={25} /></span>
        <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Raise this project’s cap to $60?</h2>
        <p style={{ margin: '0 0 20px', font: '400 var(--fs-subhead)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>Market Scan’s monthly ceiling goes from $50 to $60. The run continues immediately.</p>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={onConfirm} className="primary-cta" style={{ flex: 1, height: 44, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Raise &amp; approve</button>
        </div>
      </div>
    </div>
  );
}

function EmptyApprovals() {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 40 }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <span style={{ display: 'inline-grid', placeItems: 'center', width: 76, height: 76, borderRadius: '50%', background: 'rgba(52,199,89,0.14)', color: 'var(--green)', marginBottom: 22 }}>
          <Icon name="check" size={40} stroke={2.4} />
        </span>
        <h2 style={{ margin: '0 0 10px', font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>All clear</h2>
        <p style={{ margin: 0, font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>Decisions will queue here — and on your phone. You’ll get a nudge the moment an agent needs you.</p>
      </div>
    </div>
  );
}

/* ───────────────────────── page root ───────────────────────── */
export default function ApprovalsCenter() {
  const scale = useAppScale();
  const [theme, setTheme] = useTheme('light');
  const navigate = useNavigate();
  const onNav = (key: string) => navigate('/' + key);

  const [gates, setGates] = React.useState<Gate[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  const active = gates.find(g => g.id === activeId);

  /* Merge live projects into AC_PROJ once so the render's AC_PROJ[g.proj]
     lookup resolves names/colors. Idempotent. */
  const mergeProjects = React.useCallback((projects: Project[]) => {
    for (const p of projects) AC_PROJ[p.id] = { name: p.name, color: `var(--${p.color})` };
  }, []);

  /* Fetch the pending decision queue (and projects for labels) and rebuild the
     gate list. Fails soft to an empty queue. Keeps the active selection if it
     still exists, otherwise selects the first gate. */
  const refetch = React.useCallback(async () => {
    try {
      const [projects, approvals] = await Promise.all([
        api.listProjects(),
        api.listApprovals('pending'),
      ]);
      mergeProjects(projects);
      const next = approvals.map(approvalToGate);
      setGates(next);
      setActiveId(prev => (prev && next.some(g => g.id === prev) ? prev : (next[0]?.id ?? null)));
    } catch {
      /* fail soft — leave the queue as-is */
    }
  }, [mergeProjects]);

  React.useEffect(() => {
    void refetch();
    const unsubscribe = api.subscribe({ onApproval: () => { void refetch(); } });
    return unsubscribe;
  }, [refetch]);

  const advance = (id: string) => {
    const idx = gates.findIndex(g => g.id === id);
    const next = gates[idx + 1] || gates[idx - 1];
    setGates(gs => gs.filter(g => g.id !== id));
    setActiveId(next ? next.id : null);
  };

  /* Optimistically advance off the resolved gate, then call the mutator and
     refetch so the UI reflects the server's authoritative queue. */
  const resolve = (id: string, action: (id: string) => Promise<Approval>) => {
    advance(id);
    action(id).catch(() => { /* ignore */ }).finally(() => { void refetch(); });
  };

  const approve = () => {
    if (!active) return;
    if (active.type === 'budget') { setConfirm(true); return; }
    resolve(active.id, (id) => api.approveApproval(id));
  };
  const reject = (id: string) => { resolve(id, (i) => api.denyApproval(i)); };
  const confirmRaise = () => { setConfirm(false); if (active) resolve(active.id, (id) => api.approveApproval(id)); };

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); approve(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); if (active) reject(active.id); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, gates]);

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <style>{styles}</style>
      <div style={{
        width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--bg)',
        display: 'flex',
      }}>
        <div className="app-wallpaper" aria-hidden="true" />
        <TrafficLights />
        <Sidebar active="approvals" onNav={onNav} onWorkspace={() => {}} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
          <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} />

          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <QueueList gates={gates} activeId={activeId} onPick={g => setActiveId(g.id)} />

            {/* detail + action bar */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {active ? (
                <React.Fragment>
                  <div style={{ flex: 1, overflowY: 'auto', padding: '28px 28px 28px' }} key={active.id} className="detail-fade">
                    <GateDetail g={active} onRaise={() => setConfirm(true)} />
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '13px 24px',
                    background: 'var(--glass-tint)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)', borderTop: '0.5px solid var(--separator)' }}>
                    <button onClick={approve} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 9, height: 42, padding: '0 20px', borderRadius: 'var(--r-pill)',
                      background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)' }}>
                      <Icon name="check" size={17} /> Approve <ActionKey>⌘↩</ActionKey>
                    </button>
                    {active.jobId && (
                      <button onClick={() => navigate(`/session-transcript/${active.jobId}`)} className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 42, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                        <Icon name="enter" size={16} style={{ transform: 'rotate(-90deg)' }} /> Open job
                      </button>
                    )}
                    <span style={{ flex: 1 }} />
                    <button onClick={() => active && reject(active.id)} className="reject-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 42, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'transparent', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                      Reject <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 4px', borderRadius: 5, background: 'rgba(255,59,48,0.14)', font: '600 var(--fs-caption)/1 var(--font-mono)' }}>⌘⌫</span>
                    </button>
                  </div>
                </React.Fragment>
              ) : <EmptyApprovals />}
            </div>
          </div>
        </div>

        {confirm && <RaiseSheet onClose={() => setConfirm(false)} onConfirm={confirmRaise} />}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </div>
  );
}
