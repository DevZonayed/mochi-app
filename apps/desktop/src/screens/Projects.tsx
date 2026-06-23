/* Projects Overview — grid & list of typed projects, budgets, schedules,
   skeleton-on-load, archive → empty state, template gallery modal, ⌘K palette.
   Ported from the Babel-standalone prototype (design/project/projects/*.jsx +
   command-center/cc-palette.jsx) to an ES-module TypeScript React screen.
   Visual output (inline styles, classNames, var(--…) variables, SVG, animation
   class names) preserved exactly. */

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import { AppShell, useWorkspaceName } from '../lib/appShell';
import { api, type Project as ApiProject, type Job, type ProjectKind, type FolderInspect, type ChatSession, IS_LOCAL } from '../lib/api';
import { SessionStateDot } from './SessionStateDot';
import { useProjectRollupState } from '../lib/useSessionGitState';

/* Page-specific CSS from Projects.html <style> (the app-shell already provides
   the spin/app-wallpaper/nav-item/ws-header/search-field/tb-icon hooks, but we
   re-declare the page-local hover/animation classes used by this screen). */
const PAGE_CSS = `
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }

  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  /* project cards */
  .proj-card { transition: transform 160ms var(--spring), box-shadow 160ms ease, border-color 160ms ease; }
  .proj-card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 10px 30px rgba(15,20,60,0.12); border-color: var(--separator-strong); }
  .proj-row { transition: background 120ms ease; }
  .proj-row:hover { background: var(--fill-tertiary); }
  /* the card/row being dragged dims while the rest reflow around it */
  .proj-card.dragging, .proj-row.dragging { opacity: 0.4; }
  .proj-menu:hover { background: var(--fill-secondary); color: var(--ink); }
  .tpl-pick { transition: transform 140ms var(--spring), box-shadow 160ms ease; }
  .tpl-pick:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 8px 22px rgba(15,20,60,0.12); }

  /* skeleton shimmer */
  .shim { position: relative; overflow: hidden; background: var(--fill-secondary); }
  .shim::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ink) 6%, transparent), transparent);
    animation: shimmer 1.4s infinite; }
  @keyframes shimmer { 100% { transform: translateX(100%); } }

  /* modal + palette — frozen-clock-safe */
  @keyframes modalFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes modalPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
`;

// ── Data, template defs ────────────────────────────────────────────────────

interface TemplateDef {
  label: string;
  icon: IconName;
  tint: string;
  blurb: string;
}

const TEMPLATES: Record<string, TemplateDef> = {
  code:     { label: 'Code',     icon: 'terminal',  tint: 'var(--blue)',   blurb: 'Repos, build & test jobs, PR review gates.' },
  design:   { label: 'Design',   icon: 'brush',     tint: 'var(--teal)',   blurb: 'Asset generation, exports, brand reviews.' },
  content:  { label: 'Content',  icon: 'play',      tint: 'var(--purple)', blurb: 'Drafts, scheduling, publish approvals.' },
  research: { label: 'Research', icon: 'telescope', tint: 'var(--indigo)', blurb: 'Scans, digests, sourced summaries.' },
};

interface Project {
  id: string;
  name: string;
  tpl: string;
  jobs: number;
  gates: number;
  spent: number;
  cap: number;
  subs: number;
  next: string;
  activity: string;
  paused?: boolean;
  kind?: ProjectKind;
  path?: string;
  repoUrl?: string;
  /** Live ids of THIS project's active sessions — feeds the rollup dot. */
  sessionIds: string[];
  /** Sessions waiting for archive (their PR has merged). Drives "Archive merged" sweep. */
  mergedSessionIds: string[];
}

/* Drag-and-drop reorder wiring, shared by the grid cards and the list rows.
   Native HTML5 DnD — no library — with the parent owning the live reorder. */
interface Dnd {
  draggingId: string | null;
  start: (id: string) => void;
  over: (id: string) => void;
  end: () => void;
}

/* Props spread onto a draggable card/row root. The whole card is the handle;
   clicks still open the project (a click and a drag are distinct native events). */
function dragProps(dnd: Dnd, id: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', id); } catch { /* some engines require data set */ }
      dnd.start(id);
    },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; dnd.over(id); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); dnd.end(); },
    onDragEnd: () => dnd.end(),
  };
}

/* The five project types this screen offers → the engine `kind` they map to. */
const KIND_BY_TYPE: Record<string, ProjectKind> = { code: 'coding', design: 'content', content: 'content', research: 'research', custom: 'general' };

function shortPath(p: string): string {
  const home = '/Users/';
  const parts = p.split('/');
  const tail = parts.slice(-2).join('/');
  return p.startsWith(home) ? `~/${tail}` : tail;
}

function health(spent: number, cap: number): string {
  const pct = cap ? spent / cap : 0;
  return pct >= 0.9 ? 'var(--red)' : pct >= 0.75 ? 'var(--orange)' : 'var(--blue)';
}

/* Coerce an API project's free-form `template` string onto one of the four
   known template keys this screen renders (falls back to 'code'). */
function templateKey(t: string): string {
  const k = (t || '').toLowerCase();
  return k in TEMPLATES ? k : 'code';
}

/* Build the screen's local Project rows from the live API. Per-project job
   counts and spend are derived from listJobs(id); pending gates from the
   workspace approvals list. Fields the API does not expose (cap, subs, next,
   activity) keep sane static defaults so the render shape stays intact. */
function toRow(p: ApiProject, jobs: Job[], pendingGates: number, sessions: ChatSession[]): Project {
  const running = jobs.filter(j => j.status === 'running' || j.status === 'pending').length;
  const spent = jobs.reduce((sum, j) => sum + (j.cost || 0), 0);
  const live = sessions.filter(s => s.projectId === p.id && !s.archived && !s.archivedAt);
  return {
    id: p.id,
    name: p.name,
    tpl: templateKey(p.template),
    jobs: running,
    gates: pendingGates,
    spent,
    cap: 50,
    subs: 0,
    next: '—',
    activity: 'Idle',
    kind: p.kind,
    path: p.path,
    repoUrl: p.repoUrl,
    sessionIds: live.map(s => s.id),
    // The actual "is the PR merged?" check lives in the git-state cache; here
    // we just feed candidate session ids so the card can ask later.
    mergedSessionIds: live.map(s => s.id),
  };
}

// ── Status line ─────────────────────────────────────────────────────────────

function StatusLine({ p }: { p: Project }) {
  if (p.paused) return <span style={{ font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--red)' }}>Paused</span>;
  if (!p.jobs && !p.gates) return <span style={{ font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Idle</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
      {p.jobs > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--purple)', color: 'var(--purple)' }} />
          {`${p.jobs} ${p.jobs > 1 ? 'jobs' : 'job'} running`}
        </span>
      )}
      {p.gates > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--orange)' }} />
          {`${p.gates} ${p.gates > 1 ? 'gates' : 'gate'} waiting`}
        </span>
      )}
    </span>
  );
}

// ── Project card ────────────────────────────────────────────────────────────

interface CardProps {
  p: Project;
  onMenu: (id: string) => void;
  onOpen?: (id: string) => void;
  dnd?: Dnd;
  /** Sweep every `pr-merged` session in this project to archived. Callback fires
      after the user confirms; returns the swept count for the toast. */
  onArchiveMerged?: (projectId: string) => void | Promise<void>;
}

function ProjectCard({ p, onMenu, onOpen, dnd, onArchiveMerged }: CardProps) {
  const t = TEMPLATES[p.tpl];
  const rollup = useProjectRollupState(p.id, p.sessionIds);
  return (
    <div className={`proj-card${dnd?.draggingId === p.id ? ' dragging' : ''}`} onClick={() => onOpen && onOpen(p.id)} {...(dnd ? dragProps(dnd, p.id) : {})} style={{
      position: 'relative', background: 'var(--bg-elevated)', borderRadius: 20, overflow: 'hidden',
      border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', cursor: 'pointer',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 3, background: t.tint, flexShrink: 0 }} />
      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        {/* top row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ position: 'relative', width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'grid', placeItems: 'center',
            background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
            <Icon name={t.icon} size={22} />
            {rollup && rollup !== 'no-repo' && (
              <span style={{ position: 'absolute', right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7,
                background: 'var(--bg-elevated)', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 1px var(--separator)' }}>
                <SessionStateDot state={rollup} size={10} />
              </span>
            )}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '600 var(--fs-headline)/1.2 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
            <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{t.label}</span>
          </span>
          {!p.paused && (
            <button className="proj-menu" title="Delete project" onClick={e => { e.stopPropagation(); onMenu(p.id); }} style={{
              width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0,
            }}><Icon name="trash" size={16} /></button>
          )}
        </div>

        {/* status */}
        <StatusLine p={p} />

        {/* spend so far — no cap (subscription) */}
        <div style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
          {p.spent > 0 ? <><b style={{ color: 'var(--ink)', fontWeight: 600 }}>${p.spent.toFixed(2)}</b> spent</> : <span style={{ color: 'var(--ink-tertiary)' }}>No spend yet</span>}
        </div>

        {/* bottom row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto', paddingTop: 4 }}>
          {p.path ? (
            <span title={p.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 'var(--r-pill)', maxWidth: '70%',
              background: 'var(--fill-tertiary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
              <Icon name={p.repoUrl ? 'gitMerge' : 'folder'} size={12} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortPath(p.path)}</span>
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 'var(--r-pill)',
              background: 'var(--fill-tertiary)', font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <Icon name="layers" size={12} /> {p.subs} sub
            </span>
          )}
          <span style={{ flex: 1 }} />
          {/* Show "Archive merged" only when the rollup says the worst state of
              this project's sessions IS pr-merged (i.e. nothing more urgent is
              pending) — pure UI gate; the sweep itself re-checks per session. */}
          {rollup === 'pr-merged' && onArchiveMerged && (
            <button onClick={e => { e.stopPropagation(); void onArchiveMerged(p.id); }}
              title="Remove worktrees of every session whose PR has merged"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)',
                background: 'color-mix(in srgb, var(--purple) 14%, transparent)', color: 'var(--purple)',
                font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>
              <Icon name="archive" size={11} /> Archive merged
            </button>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>
            <Icon name="clock" size={12} /> {p.next === '—' ? p.activity : `Next ${p.next}`}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Project list row ────────────────────────────────────────────────────────

interface RowProps {
  p: Project;
  onMenu: (id: string) => void;
  onOpen?: (id: string) => void;
  last: boolean;
  dnd?: Dnd;
}

function ProjectRow({ p, onMenu, onOpen, last, dnd }: RowProps) {
  const t = TEMPLATES[p.tpl];
  const rollup = useProjectRollupState(p.id, p.sessionIds);
  return (
    <div className={`proj-row${dnd?.draggingId === p.id ? ' dragging' : ''}`} onClick={() => onOpen && onOpen(p.id)} {...(dnd ? dragProps(dnd, p.id) : {})} style={{
      display: 'grid', gridTemplateColumns: '2fr 1.5fr 1.4fr 0.8fr 1fr 36px', alignItems: 'center', gap: 14,
      padding: '13px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span style={{ position: 'relative', width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
          <Icon name={t.icon} size={17} />
          {rollup && rollup !== 'no-repo' && (
            <span style={{ position: 'absolute', right: -2, bottom: -2, width: 12, height: 12, borderRadius: 6,
              background: 'var(--bg-elevated)', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 1px var(--separator)' }}>
              <SessionStateDot state={rollup} size={8} />
            </span>
          )}
        </span>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
          <span style={{ display: 'block', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 1 }}>{t.label}</span>
        </span>
      </div>
      <div><StatusLine p={p} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>{p.spent > 0 ? `$${p.spent.toFixed(2)}` : '—'}</span>
      </div>
      <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{p.path ? (p.repoUrl ? 'repo' : 'folder') : '—'}</span>
      <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{p.next === '—' ? p.activity : `Next ${p.next}`}</span>
      <button className="proj-menu" title="Delete project" onClick={e => { e.stopPropagation(); onMenu(p.id); }} style={{
        width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
        <Icon name="trash" size={16} />
      </button>
    </div>
  );
}

// ── Segmented control ───────────────────────────────────────────────────────

interface SegmentedOption {
  key: string;
  label: string;
  icon: IconName;
}

interface SegmentedProps {
  value: string;
  onChange: (key: string) => void;
  options: SegmentedOption[];
}

function Segmented({ value, onChange, options }: SegmentedProps) {
  const i = options.findIndex(o => o.key === value);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
      <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${i * 50}% + 2px)`, width: `calc(50% - 4px)`,
        background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 240ms var(--spring)' }} />
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)} style={{
          position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px',
          font: '600 var(--fs-subhead)/1 var(--font-text)', color: value === o.key ? 'var(--ink)' : 'var(--ink-secondary)' }}>
          <Icon name={o.icon} size={15} /> {o.label}
        </button>
      ))}
    </div>
  );
}

// ── List table ──────────────────────────────────────────────────────────────

interface ListTableProps {
  projects: Project[];
  onMenu: (id: string) => void;
  onOpen?: (id: string) => void;
  dnd?: Dnd;
}

function ListTable({ projects, onMenu, onOpen, dnd }: ListTableProps) {
  const [sort, setSort] = React.useState<string>('activity');
  const sorted = [...projects].sort((a, b) => sort === 'spend' ? b.spent - a.spent : 0);
  const cols: [string, string | null][] = [['Project', null], ['Status', null], ['Spend', 'spend'], ['Source', null], ['Schedule', 'activity'], ['', null]];
  return (
    <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      {/* header */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.5fr 1.4fr 0.8fr 1fr 36px', alignItems: 'center', gap: 14,
        padding: '11px 16px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
        {cols.map(([label, key], i) => (
          <button key={i} onClick={() => key && setSort(key)} style={{ textAlign: 'left', cursor: key ? 'pointer' : 'default',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase',
            color: sort === key ? 'var(--blue)' : 'var(--ink-tertiary)' }}>
            {label}{key && <Icon name="chevronDown" size={11} />}
          </button>
        ))}
      </div>
      {sorted.map((p, i) => <ProjectRow key={p.id} p={p} onMenu={onMenu} onOpen={onOpen} last={i === sorted.length - 1} dnd={sort === 'spend' ? undefined : dnd} />)}
    </div>
  );
}

// ── Skeleton ────────────────────────────────────────────────────────────────

function SkeletonGrid({ view }: { view: string }) {
  if (view === 'list') {
    return (
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 16px', borderBottom: i < 5 ? '0.5px solid var(--separator)' : 'none' }}>
            <span className="shim" style={{ width: 32, height: 32, borderRadius: 9 }} />
            <span className="shim" style={{ width: 140, height: 12, borderRadius: 6 }} />
            <span style={{ flex: 1 }} />
            <span className="shim" style={{ width: 90, height: 8, borderRadius: 5 }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(316px, 1fr))', gap: 18 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} style={{ background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--separator)', padding: 18, boxShadow: 'var(--card-shadow)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span className="shim" style={{ width: 42, height: 42, borderRadius: 12 }} />
            <span><span className="shim" style={{ display: 'block', width: 120, height: 13, borderRadius: 6 }} /><span className="shim" style={{ display: 'block', width: 60, height: 9, borderRadius: 5, marginTop: 7 }} /></span>
          </div>
          <span className="shim" style={{ display: 'block', width: 150, height: 10, borderRadius: 5, marginBottom: 16 }} />
          <span className="shim" style={{ display: 'block', width: '100%', height: 5, borderRadius: 3, marginBottom: 10 }} />
          <span className="shim" style={{ display: 'block', width: 80, height: 9, borderRadius: 5 }} />
        </div>
      ))}
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyProjects({ onPick }: { onPick: () => void }) {
  const items = Object.entries(TEMPLATES);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '70px 20px' }}>
      <span style={{ width: 64, height: 64, borderRadius: 18, display: 'grid', placeItems: 'center', marginBottom: 20,
        background: 'var(--fill-secondary)', color: 'var(--ink-tertiary)' }}>
        <Icon name="layers" size={32} />
      </span>
      <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.15 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>No projects yet</h2>
      <p style={{ margin: '0 0 26px', maxWidth: 380, font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
        Projects keep instructions, budget, and schedules together. Create one from a template.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
        {items.map(([k, t]) => (
          <button key={k} onClick={onPick} className="tpl-pick" style={{
            display: 'inline-flex', alignItems: 'center', gap: 9, height: 44, padding: '0 16px 0 12px', borderRadius: 'var(--r-pill)',
            background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)',
            font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>
            <span style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center',
              background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}><Icon name={t.icon} size={16} /></span>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Template gallery modal ──────────────────────────────────────────────────

interface GalleryItem {
  key: string;
  label: string;
  icon: IconName;
  tint: string;
  blurb: string;
}

const TYPE_ITEMS: GalleryItem[] = [
  { key: 'code',     label: 'Code',     icon: 'terminal',  tint: 'var(--blue)',   blurb: 'Open a folder or clone a repo. The coding agent builds, tests, and edits in it.' },
  { key: 'design',   label: 'Design',   icon: 'brush',     tint: 'var(--teal)',   blurb: 'Generate and export assets at scale, with brand-review gates before anything ships.' },
  { key: 'content',  label: 'Content',  icon: 'play',      tint: 'var(--purple)', blurb: 'Draft, schedule, and publish across channels — every post waits for your approval.' },
  { key: 'research', label: 'Research', icon: 'telescope', tint: 'var(--indigo)', blurb: 'Run recurring scans and digests with sourced, citation-backed summaries.' },
  { key: 'custom',   label: 'Custom',   icon: 'sliders',   tint: 'var(--ink-secondary)', blurb: 'Start blank. Bring your own goal, tools, and schedule.' },
];

type CodeSource = 'folder' | 'clone';

const baseNameOf = (p: string): string => p.split('/').filter(Boolean).pop() ?? '';
const repoNameOf = (url: string): string => url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop() ?? '';
/** Local helper — used by the slug-check effect so it doesn't fire on the
    non-code project types where there's no folder to push. */
const isCodeType = (type: string): boolean => type === 'code';

/** Live slug-availability chip shown under the project-name input. Three
    visual states map to the four data states: checking (neutral spinner) /
    available (green) / taken (amber, with the v2 fallback inline) /
    unauthenticated or error (muted hint). Pure presentation — the parent
    owns the debounce + the actual API call. */
function SlugChip({ state }: { state: SlugProbeState }): React.ReactElement | null {
  if (state.status === 'checking') {
    return (
      <span style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)' }}>
        <span className="breathe" style={{ width: 6, height: 6, borderRadius: 4, background: 'var(--ink-secondary)' }} />
        Checking availability…
      </span>
    );
  }
  if (state.status === 'available' && state.owner) {
    return (
      <span style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999, background: 'color-mix(in srgb, var(--green) 15%, var(--bg-elevated))', color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
        <Icon name="check" size={12} stroke={3} />
        Available — <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)' }}>{state.owner}/{state.slug}</span>
      </span>
    );
  }
  if (state.status === 'taken' && state.owner) {
    return (
      <span style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999, background: 'color-mix(in srgb, var(--orange, #ff9500) 18%, var(--bg-elevated))', color: 'var(--orange, #ff9500)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
        Name taken — will use <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)' }}>{state.owner}/{state.suggestion}</span>
      </span>
    );
  }
  if (state.status === 'unauthenticated') {
    return (
      <span style={{ marginTop: 8, display: 'inline-block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
        Sign in to GitHub in Settings to check availability live.
      </span>
    );
  }
  if (state.status === 'error') {
    return (
      <span style={{ marginTop: 8, display: 'inline-block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
        Couldn't check availability ({state.error ?? 'network error'}). Will retry on create.
      </span>
    );
  }
  return null;
}

/* Two-step New-project sheet. Step 1 picks the type. For Code projects, step 2
   has no "blank": you either Open an existing folder (that folder IS the project,
   named from its folder name) or Clone a repo into a destination you choose
   (named from the repo). Names auto-fill and de-dupe to "name v1" on collision. */
/* Live slug-availability state for the GitHub-first name field. `null` for
   "haven't checked yet" / "user isn't signed in" — the UI treats those
   distinctly from a real availability answer. */
type SlugProbeStatus = 'idle' | 'checking' | 'available' | 'taken' | 'unauthenticated' | 'error';
interface SlugProbeState {
  status: SlugProbeStatus;
  slug: string;             // slugified form of the current name
  suggestion: string;       // what bootstrap would actually use
  owner: string | null;
  existingFullName?: string;
  error?: string;
}

function NewProjectSheet({ open, onClose, onCreated, suggestedName }: { open: boolean; onClose: () => void; onCreated: (projectId: string) => void; suggestedName?: string }) {
  const [step, setStep] = React.useState<1 | 2>(1);
  const [type, setType] = React.useState('code');
  const [name, setName] = React.useState('');
  const [nameEdited, setNameEdited] = React.useState(false);
  const [source, setSource] = React.useState<CodeSource>('folder');
  const [repoUrl, setRepoUrl] = React.useState('');
  const [picked, setPicked] = React.useState<FolderInspect | null>(null);
  const [pickedPath, setPickedPath] = React.useState('');
  const [destPath, setDestPath] = React.useState('');
  const [cloneLines, setCloneLines] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  // Push the project to GitHub on create (only meaningful for code/folder source).
  const [pushToGitHub, setPushToGitHub] = React.useState(true);
  const [slugProbe, setSlugProbe] = React.useState<SlugProbeState>({ status: 'idle', slug: '', suggestion: '', owner: null });
  // The successful bootstrap result, captured so the "Done" step can show
  // "Created github.com/owner/slug ✓" with a click-through link.
  const [bootstrapped, setBootstrapped] = React.useState<{ fullName: string; htmlUrl: string; slugChanged: boolean } | null>(null);

  React.useEffect(() => {
    if (open) { setStep(1); setType('code'); setName(suggestedName ?? ''); setNameEdited(!!suggestedName); setSource('folder'); setRepoUrl(''); setPicked(null); setPickedPath(''); setDestPath(''); setCloneLines([]); setBusy(false); setError(''); setPushToGitHub(true); setSlugProbe({ status: 'idle', slug: '', suggestion: '', owner: null }); setBootstrapped(null); }
  }, [open, suggestedName]);

  /* Live slug-availability check. Debounced 300ms so a fast typist isn't
     pummelling GitHub. Only runs when the user has typed at least 1 char,
     is on the Code branch with GitHub-push enabled, AND is on step 2 (the
     check is meaningless on the type picker). The leading `null` reason
     ('not-authenticated') short-circuits to a friendly UI hint without an
     API call. */
  const trimmedName = name.trim();
  const slugCheckEnabled = step === 2 && isCodeType(type) && pushToGitHub && trimmedName.length > 0;
  React.useEffect(() => {
    if (!slugCheckEnabled) { setSlugProbe({ status: 'idle', slug: '', suggestion: '', owner: null }); return; }
    setSlugProbe(s => ({ ...s, status: 'checking' }));
    const timer = setTimeout(async () => {
      try {
        const r = await api.checkSlug(trimmedName);
        if (r.reason === 'not-authenticated') {
          setSlugProbe({ status: 'unauthenticated', slug: r.slug, suggestion: r.suggestion, owner: null });
        } else if (r.reason === 'error') {
          setSlugProbe({ status: 'error', slug: r.slug, suggestion: r.suggestion, owner: null, error: r.error });
        } else if (r.available === true) {
          setSlugProbe({ status: 'available', slug: r.slug, suggestion: r.slug, owner: r.owner });
        } else if (r.available === false) {
          setSlugProbe({ status: 'taken', slug: r.slug, suggestion: r.suggestion, owner: r.owner, existingFullName: r.existing?.fullName });
        }
      } catch (e) {
        setSlugProbe({ status: 'error', slug: '', suggestion: '', owner: null, error: e instanceof Error ? e.message.slice(0, 160) : 'lookup failed' });
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmedName, slugCheckEnabled]);

  // Stream clone progress lines while a clone is in flight.
  React.useEffect(() => {
    if (!busy || source !== 'clone') return;
    const unsub = api.subscribe({
      onClone: (e) => {
        if (e.phase === 'progress') setCloneLines(ls => [...ls.slice(-40), e.line]);
        else if (e.phase === 'failed') setError(e.error);
      },
    });
    return unsub;
  }, [busy, source]);

  if (!open) return null;
  const meta = TYPE_ITEMS.find(t => t.key === type) ?? TYPE_ITEMS[0];
  const isCode = type === 'code';

  const editName = (v: string) => { setName(v); setNameEdited(true); };
  const autoName = (v: string) => { if (!nameEdited) setName(v); };

  // Open folder → the folder IS the project; name it from the folder.
  const chooseFolder = async () => {
    setError('');
    try {
      const res = await api.pickFolder();
      if (!res) return; // cancelled
      if (!res.ok) { setError(res.error ?? 'Could not open that folder.'); return; }
      setPicked(res); setPickedPath(res.path);
      autoName(baseNameOf(res.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open folder.');
    }
  };

  // Clone → choose the destination folder the repo is cloned into.
  const chooseDest = async () => {
    setError('');
    try {
      const res = await api.pickFolder();
      if (!res) return;
      if (!res.ok) { setError(res.error ?? 'Could not open that folder.'); return; }
      setDestPath(res.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open folder.');
    }
  };

  const onUrl = (v: string) => { setRepoUrl(v); autoName(repoNameOf(v)); };

  const create = async () => {
    setError('');
    setBusy(true);
    try {
      if (isCode && source === 'clone') {
        const url = repoUrl.trim();
        if (!url) { setError('Enter a GitHub URL.'); setBusy(false); return; }
        if (!destPath) { setError('Choose a destination folder for the clone.'); setBusy(false); return; }
        setCloneLines(['Cloning…']);
        const proj = await api.cloneRepo({ url, dest: destPath, name: name.trim() || undefined });
        onCreated(proj.id);
        return;
      }
      if (isCode) {
        if (!pickedPath) { setError('Choose a folder to open.'); setBusy(false); return; }
        const finalName = name.trim() || baseNameOf(pickedPath);

        // GitHub-first path: inspect the folder first so we know whether to
        // skip the local `git init` (already a repo) or skip the seed/commit
        // entirely (already a repo WITH a github remote that we just record).
        if (pushToGitHub) {
          let inspect: Awaited<ReturnType<typeof api.adoptFolderInspect>> | null = null;
          try { inspect = await api.adoptFolderInspect(pickedPath); } catch { /* fall back to plain create below */ }
          if (inspect?.ok && inspect.kind === 'git-github') {
            // Folder already has a GitHub remote — record it on the project
            // without recreating anything.
            const proj = await api.createProject({ name: finalName, template: 'code', kind: 'coding', path: pickedPath, repoUrl: inspect.remote ?? undefined });
            onCreated(proj.id);
            return;
          }
          // No GitHub remote yet (or no git at all): bootstrap a fresh repo
          // under the operator's GitHub account, then create the project.
          const result = await api.bootstrapProject({
            name: finalName,
            localPath: pickedPath,
            private: true,
            adopt: !!inspect?.ok && inspect.kind !== 'no-git',
          });
          // No `owner` passed → server returns the legacy single-repo shape.
          // Step 9 (renderer owner picker) routes the new shape through a
          // separate code path that surfaces both URLs.
          const legacy = result as { slug: string; slugChanged: boolean; owner: string; fullName: string; htmlUrl: string; cloneUrl: string; localPath: string; branchPushed: string };
          const proj = await api.createProject({ name: finalName, template: 'code', kind: 'coding', path: pickedPath, repoUrl: legacy.cloneUrl });
          setBootstrapped({ fullName: legacy.fullName, htmlUrl: legacy.htmlUrl, slugChanged: legacy.slugChanged });
          // Stay on the dialog briefly so the user sees the confirmation chip;
          // onCreated still fires so the parent navigates / refreshes the list.
          setBusy(false);
          setTimeout(() => onCreated(proj.id), 850);
          return;
        }

        const proj = await api.createProject({ name: finalName, template: 'code', kind: 'coding', path: pickedPath });
        onCreated(proj.id);
        return;
      }
      // Non-code types have no folder — a named project to bring your own goal to.
      const proj = await api.createProject({ name: name.trim() || `${meta.label} Project`, template: type, kind: KIND_BY_TYPE[type] ?? 'general' });
      onCreated(proj.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the project.');
      setBusy(false);
    }
  };

  const canCreate = !busy && (
    !isCode
      ? true
      : source === 'clone' ? (repoUrl.trim().length > 0 && !!destPath) : !!pickedPath
  );

  return (
    <div onMouseDown={busy ? undefined : onClose} style={{
      position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width: 720, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 20,
        border: '0.5px solid var(--glass-border)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        boxShadow: '0 40px 100px rgba(10,15,40,0.5), var(--glass-inner)', overflow: 'hidden',
        animation: 'modalPop 220ms var(--spring)',
      }}>
        <div style={{ padding: '22px 24px 16px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>New project</h2>
              <p style={{ margin: '5px 0 0', font: '400 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
                {step === 1 ? 'Pick a type. Code projects open a folder or clone a repo.' : `Name your ${meta.label.toLowerCase()} project${isCode ? ' and choose a source.' : '.'}`}
              </p>
            </div>
            <button onClick={onClose} className="tb-icon" disabled={busy} style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', opacity: busy ? 0.4 : 1 }}>
              <Icon name="x" size={18} />
            </button>
          </div>
        </div>

        {step === 1 ? (
          <div style={{ padding: 18, overflowY: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {TYPE_ITEMS.map(it => {
              const on = type === it.key;
              return (
                <button key={it.key} onClick={() => setType(it.key)} style={{
                  textAlign: 'left', display: 'flex', gap: 12, padding: 14, borderRadius: 14,
                  background: on ? `color-mix(in srgb, ${it.tint} 9%, var(--bg-elevated))` : 'var(--fill-tertiary)',
                  border: `1.5px solid ${on ? it.tint : 'transparent'}`, transition: 'border-color 140ms ease, background 140ms ease',
                }}>
                  <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center',
                    background: `color-mix(in srgb, ${it.tint} 16%, transparent)`, color: it.tint }}>
                    <Icon name={it.icon} size={20} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>
                      {it.label}
                      {on && <Icon name="check" size={14} stroke={3} style={{ color: it.tint }} />}
                    </span>
                    <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4, textWrap: 'pretty' }}>{it.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
            {isCode && !IS_LOCAL ? (
              <div style={{ padding: '16px 18px', borderRadius: 12, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
                Coding projects open a folder or clone a repo on your Mac — create them in the <b style={{ color: 'var(--ink)' }}>Maestro desktop app</b>. (This is a remote view.)
              </div>
            ) : (
            <>
            {isCode ? (
              <div>
                <span style={{ display: 'block', font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 7 }}>Source</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {([['folder', 'folder', 'Open folder', 'Use a folder already on your Mac'], ['clone', 'gitMerge', 'Clone from GitHub', 'Clone a repo into a folder you pick']] as [CodeSource, IconName, string, string][]).map(([k, icon, label, blurb]) => {
                    const on = source === k;
                    return (
                      <button key={k} onClick={() => { setSource(k); setError(''); }} style={{
                        flex: 1, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '13px 14px', borderRadius: 12, textAlign: 'left',
                        background: on ? 'color-mix(in srgb, var(--blue) 10%, var(--bg-elevated))' : 'var(--fill-tertiary)',
                        border: `1.5px solid ${on ? 'var(--blue)' : 'transparent'}`, cursor: 'pointer' }}>
                        <Icon name={icon} size={20} style={{ color: on ? 'var(--blue)' : 'var(--ink-secondary)', flexShrink: 0, marginTop: 1 }} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: on ? 'var(--blue)' : 'var(--ink)' }}>{label}</span>
                          <span style={{ display: 'block', font: '400 var(--fs-caption)/1.35 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>{blurb}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {source === 'folder' && (
                  <div style={{ marginTop: 14 }}>
                    <button onClick={chooseFolder} className="primary-cta" style={{ height: 42, padding: '0 16px', borderRadius: 11, background: pickedPath ? 'var(--fill-secondary)' : 'var(--blue)', color: pickedPath ? 'var(--ink)' : '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Icon name="folder" size={16} /> {pickedPath ? 'Change folder…' : 'Choose a folder…'}
                    </button>
                    {pickedPath && (
                      <div style={{ marginTop: 11, display: 'flex', alignItems: 'center', gap: 8, font: '500 var(--fs-footnote)/1.3 var(--font-mono)', color: 'var(--ink-secondary)' }}>
                        <Icon name="check" size={14} stroke={2.6} style={{ color: 'var(--green)' }} />
                        {shortPath(pickedPath)}
                        {picked?.info?.isRepo && <span style={{ color: 'var(--ink-tertiary)' }}>· git{picked.info.branch ? ` (${picked.info.branch})` : ''}</span>}
                      </div>
                    )}
                  </div>
                )}

                {source === 'clone' && (
                  <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 11 }}>
                    <div>
                      <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', letterSpacing: '0.03em', textTransform: 'uppercase', marginBottom: 6 }}>Repository URL</span>
                      <input value={repoUrl} onChange={e => onUrl(e.target.value)} placeholder="https://github.com/owner/repo"
                        style={{ width: '100%', height: 40, padding: '0 13px', borderRadius: 10, boxSizing: 'border-box', border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-mono)' }} />
                    </div>
                    <div>
                      <span style={{ display: 'block', font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', letterSpacing: '0.03em', textTransform: 'uppercase', marginBottom: 6 }}>Destination · required</span>
                      <button onClick={chooseDest} style={{ height: 40, padding: '0 14px', borderRadius: 10, background: destPath ? 'var(--fill-secondary)' : 'color-mix(in srgb, var(--blue) 12%, var(--bg-elevated))', color: destPath ? 'var(--ink)' : 'var(--blue)', border: destPath ? 'none' : '1px solid var(--blue)', font: '600 var(--fs-footnote)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <Icon name="folder" size={15} /> {destPath ? 'Change destination…' : 'Choose destination…'}
                      </button>
                      {destPath && <div style={{ marginTop: 8, font: '500 var(--fs-caption)/1.3 var(--font-mono)', color: 'var(--ink-secondary)' }}>Clones into {shortPath(destPath)}/{repoNameOf(repoUrl) || '<repo>'}</div>}
                    </div>
                    {(busy || cloneLines.length > 0) && (
                      <div style={{ maxHeight: 120, overflowY: 'auto', padding: '10px 12px', borderRadius: 10, background: 'var(--bg)', border: '0.5px solid var(--separator)', font: '400 var(--fs-caption)/1.5 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'pre-wrap' }}>
                        {cloneLines.length ? cloneLines.join('\n') : 'Cloning…'}
                      </div>
                    )}
                    <p style={{ margin: 0, font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                      Public repos clone directly. For private repos, authenticate git on this Mac first (e.g. <code>gh auth login</code>).
                    </p>
                  </div>
                )}
              </div>
            ) : null}

            <label style={{ display: 'block' }}>
              <span style={{ display: 'block', font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 7 }}>Project name{isCode ? ' · auto-filled, editable' : ''}</span>
              <input value={name} onChange={e => editName(e.target.value)} placeholder={isCode ? (source === 'clone' ? 'from the repo name' : 'from the folder name') : `${meta.label} Project`}
                style={{ width: '100%', height: 42, padding: '0 13px', borderRadius: 11, boxSizing: 'border-box',
                  border: '1px solid var(--separator-strong)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-body)/1 var(--font-text)' }} />
              {/* Slug-availability chip — only on Code+folder (where we'll
                  push to GitHub) and only once the user has typed something.
                  We render nothing while idle so the UI doesn't flash. */}
              {isCode && source === 'folder' && pushToGitHub && slugProbe.status !== 'idle' && (
                <SlugChip state={slugProbe} />
              )}
            </label>

            {/* GitHub-first toggle. Only Code+folder, because Code+clone
                already comes from GitHub and the non-code project kinds have
                no folder to push. */}
            {isCode && source === 'folder' && (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '12px 14px', borderRadius: 12, background: pushToGitHub ? 'color-mix(in srgb, var(--blue) 7%, var(--bg-elevated))' : 'var(--fill-tertiary)', border: `1px solid ${pushToGitHub ? 'color-mix(in srgb, var(--blue) 40%, transparent)' : 'transparent'}` }}>
                <input type="checkbox" checked={pushToGitHub} onChange={e => setPushToGitHub(e.target.checked)} style={{ marginTop: 2 }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Create a GitHub repo for this project</span>
                  <span style={{ display: 'block', font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 3 }}>
                    Initialises git, seeds README + .gitignore + .continuum/STATE.md, and pushes an initial commit to a private repo on your GitHub account.
                  </span>
                </span>
              </label>
            )}

            {bootstrapped && (
              <div style={{ padding: '12px 14px', borderRadius: 12, background: 'color-mix(in srgb, var(--green) 12%, var(--bg-elevated))', border: '1px solid color-mix(in srgb, var(--green) 35%, transparent)', display: 'flex', alignItems: 'center', gap: 9, font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>
                <Icon name="check" size={16} stroke={3} style={{ color: 'var(--green)', flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  Created <a href={bootstrapped.htmlUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)', textDecoration: 'none', font: '600 var(--fs-footnote)/1.4 var(--font-mono)' }}>github.com/{bootstrapped.fullName}</a>
                  {bootstrapped.slugChanged && <span style={{ marginLeft: 6, color: 'var(--ink-tertiary)' }}>(name was taken — used the v2 form)</span>}
                </span>
              </div>
            )}

            {error && <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(255,59,48,0.1)', color: 'var(--red)', font: '500 var(--fs-footnote)/1.4 var(--font-text)' }}>{error}</div>}
            </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <span style={{ flex: 1, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            {step === 2 && isCode && source === 'folder' ? 'The folder you pick is the project — jobs run inside it.' : step === 2 && isCode ? 'Names that already exist become “name v1”, “name v2”…' : 'You can change instructions and engine after creating.'}
          </span>
          {step === 2 && <button onClick={() => setStep(1)} disabled={busy} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)', opacity: busy ? 0.5 : 1 }}>Back</button>}
          {step === 1
            ? <button onClick={() => setStep(2)} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Continue</button>
            : <button onClick={create} disabled={!canCreate} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: canCreate ? 'var(--blue)' : 'var(--fill-secondary)', color: canCreate ? '#fff' : 'var(--ink-tertiary)', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: canCreate ? '0 6px 18px rgba(0,122,255,0.3)' : 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {busy && <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: '#fff' }} />}
                {busy ? (source === 'clone' ? 'Cloning…' : 'Creating…') : source === 'clone' ? 'Clone & create' : 'Create project'}
              </button>}
        </div>
      </div>
    </div>
  );
}

// ── Command palette (ported from command-center/cc-palette.jsx) ──────────────

interface PaletteItem {
  group: string;
  icon: IconName;
  label: string;
  hint: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
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
          {Object.entries(groups).map(([group, gItems]) => (
            <div key={group} style={{ marginBottom: 6 }}>
              <div style={{ padding: '6px 10px 4px', font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{group}</div>
              {gItems.map(it => {
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

// ── Page ────────────────────────────────────────────────────────────────────

export default function Projects() {
  const navigate = useNavigate();
  const location = useLocation();
  const workspaceName = useWorkspaceName();
  const [view, setView] = React.useState('grid');
  const [loading, setLoading] = React.useState(true);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [budget, setBudget] = React.useState<{ spent: number; cap: number }>({ spent: 0, cap: 200 });
  const [galleryOpen, setGalleryOpen] = React.useState(false);
  const [suggestedName, setSuggestedName] = React.useState<string | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [confirmDel, setConfirmDel] = React.useState<string | null>(null);

  // Opened with router state { openNew: true } → open the New-project sheet.
  React.useEffect(() => {
    const st = location.state as { openNew?: boolean; suggestedName?: string } | null;
    if (st?.openNew) {
      setSuggestedName(st.suggestedName);
      setGalleryOpen(true);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);

  const load = React.useCallback(async () => {
    try {
      const [apiProjects, pendingGates, budgetData, allSessions] = await Promise.all([
        api.listProjects(),
        api.listApprovals('pending'),
        api.budget(),
        api.listSessions().catch(() => [] as ChatSession[]),
      ]);
      const jobsByProject = await Promise.all(
        apiProjects.map(p => api.listJobs(p.id).catch(() => [] as Job[])),
      );
      const gatesByProject = pendingGates.reduce<Record<string, number>>((acc, g) => {
        if (g.projectId) acc[g.projectId] = (acc[g.projectId] ?? 0) + 1;
        return acc;
      }, {});
      setProjects(apiProjects.map((p, i) => toRow(p, jobsByProject[i] ?? [], gatesByProject[p.id] ?? 0, allSessions)));
      setBudget({ spent: budgetData.spent, cap: budgetData.cap });
    } catch {
      /* fail soft — leave whatever state we have */
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const onCreated = async (projectId: string) => {
    setGalleryOpen(false);
    await load();
    navigate(`/project-detail/${projectId}`);
  };

  // Delete a project — confirm first, then persist (the old "archive" only hid it
  // from local state, so it reappeared on reload).
  const requestDelete = (id: string) => setConfirmDel(id);
  const deleteProject = (id: string) => {
    setConfirmDel(null);
    setProjects(ps => ps.filter(p => p.id !== id));
    void api.deleteProject(id).catch(() => { void load(); });
  };
  const open = (id: string) => { navigate(`/project-detail/${id}`); };

  /* Project-card sweep: prune the worktree of every session whose PR has merged.
     Best-effort — fetches each candidate's git status WITH PR data, then calls
     archiveSessionWorktree for `pr-merged` only. The card's button shows up only
     when at least one merged session exists. */
  const archiveMergedFor = async (projectId: string) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj || proj.mergedSessionIds.length === 0) return;
    const statuses = await Promise.all(proj.mergedSessionIds.map(sid => api.getSessionGitStatus(sid).catch(() => null)));
    const targets = statuses.filter((s): s is NonNullable<typeof s> => !!s && s.state === 'pr-merged').map(s => s.sessionId);
    if (targets.length === 0) {
      // Nothing actually merged yet — silently no-op (the button is hidden anyway).
      return;
    }
    const ok = window.confirm(`Archive ${targets.length} merged ${targets.length === 1 ? 'session' : 'sessions'} in “${proj.name}”? Their worktrees are removed; chats stay (archived).`);
    if (!ok) return;
    // Fire all archives in parallel; the rail will reload on the next load() pass.
    await Promise.all(targets.map(sid => api.archiveSessionWorktree(sid).catch(() => undefined)));
    void load();
  };

  // ── Drag-and-drop reorder ─────────────────────────────────────────────────
  // Cards/rows reflow live as you drag (a "last hovered" ref stops oscillation),
  // and the new order is committed to the engine on drop. The store persists it
  // and sorts projects by it, so the order survives reload and syncs to remotes.
  const dragIdRef = React.useRef<string | null>(null);
  const lastOverRef = React.useRef<string | null>(null);
  const orderRef = React.useRef<string[]>([]);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  React.useEffect(() => { orderRef.current = projects.map(p => p.id); }, [projects]);
  const dnd: Dnd = React.useMemo(() => ({
    draggingId,
    start: (id: string) => { dragIdRef.current = id; lastOverRef.current = id; setDraggingId(id); },
    over: (overId: string) => {
      const from = dragIdRef.current;
      if (!from || overId === from || lastOverRef.current === overId) return;
      lastOverRef.current = overId;
      setProjects(ps => {
        const fromIdx = ps.findIndex(p => p.id === from);
        const toIdx = ps.findIndex(p => p.id === overId);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return ps;
        const next = [...ps];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        return next;
      });
    },
    end: () => {
      const moved = dragIdRef.current;
      dragIdRef.current = null;
      lastOverRef.current = null;
      setDraggingId(null);
      if (moved) void api.reorderProjects(orderRef.current).catch(() => { void load(); });
    },
  }), [draggingId, load]);

  const newBtn = (
    <button onClick={() => setGalleryOpen(true)} className="primary-cta" style={{
      display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
      background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)',
    }}>
      <Icon name="plus" size={16} stroke={2.4} /> New project
    </button>
  );

  return (
    <>
      <style>{PAGE_CSS}</style>
      <AppShell active="projects" onSearch={() => setPaletteOpen(true)}>
        <div style={{ padding: '26px 28px 32px' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22, gap: 16 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Projects</h1>
              <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
                {projects.length} project{projects.length !== 1 ? 's' : ''} in {workspaceName}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Segmented value={view} onChange={setView}
                options={[{ key: 'grid', label: 'Grid', icon: 'layers' }, { key: 'list', label: 'List', icon: 'jobs' }]} />
              {newBtn}
            </div>
          </div>

          {loading ? <SkeletonGrid view={view} />
            : projects.length === 0 ? <EmptyProjects onPick={() => setGalleryOpen(true)} />
            : view === 'grid'
              ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(316px, 1fr))', gap: 18 }}>
                  {projects.map(p => <ProjectCard key={p.id} p={p} onMenu={requestDelete} onOpen={open} dnd={dnd} onArchiveMerged={archiveMergedFor} />)}
                </div>
              : <ListTable projects={projects} onMenu={requestDelete} onOpen={open} dnd={dnd} />}
        </div>
      </AppShell>

      <NewProjectSheet open={galleryOpen} onClose={() => { setGalleryOpen(false); setSuggestedName(undefined); }} onCreated={onCreated} suggestedName={suggestedName} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {confirmDel && (() => {
        const p = projects.find(x => x.id === confirmDel);
        return (
          <div onClick={() => setConfirmDel(null)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(8,10,30,0.34)', backdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', padding: 20 }}>
            <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" style={{ width: 'min(420px, 100%)', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 16, boxShadow: 'var(--shadow-lg, 0 24px 70px rgba(15,20,60,0.32))', padding: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <span style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--red, #ff3b30) 14%, transparent)', color: 'var(--red, #ff3b30)' }}>
                  <Icon name="trash" size={20} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ font: '700 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>Delete project?</div>
                  <div style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p?.name ?? 'This project'}</div>
                </div>
              </div>
              <p style={{ margin: '0 0 18px', font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
                This removes the project and its chats from Maestro. {p?.path ? 'The folder on disk is left untouched.' : ''} This can’t be undone.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setConfirmDel(null)} style={{ height: 36, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => deleteProject(confirmDel)} style={{ height: 36, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--red, #ff3b30)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Delete project</button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}
