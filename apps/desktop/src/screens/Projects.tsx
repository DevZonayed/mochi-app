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
import { api, type Project as ApiProject, type Job, type ProjectKind, type FolderInspect, IS_LOCAL } from '../lib/api';

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
function toRow(p: ApiProject, jobs: Job[], pendingGates: number): Project {
  const running = jobs.filter(j => j.status === 'running' || j.status === 'pending').length;
  const spent = jobs.reduce((sum, j) => sum + (j.cost || 0), 0);
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
}

function ProjectCard({ p, onMenu, onOpen }: CardProps) {
  const t = TEMPLATES[p.tpl];
  return (
    <div className="proj-card" onClick={() => onOpen && onOpen(p.id)} style={{
      position: 'relative', background: 'var(--bg-elevated)', borderRadius: 20, overflow: 'hidden',
      border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', cursor: 'pointer',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 3, background: t.tint, flexShrink: 0 }} />
      <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
        {/* top row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, display: 'grid', placeItems: 'center',
            background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
            <Icon name={t.icon} size={22} />
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
}

function ProjectRow({ p, onMenu, onOpen, last }: RowProps) {
  const t = TEMPLATES[p.tpl];
  return (
    <div className="proj-row" onClick={() => onOpen && onOpen(p.id)} style={{
      display: 'grid', gridTemplateColumns: '2fr 1.5fr 1.4fr 0.8fr 1fr 36px', alignItems: 'center', gap: 14,
      padding: '13px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
          <Icon name={t.icon} size={17} />
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
}

function ListTable({ projects, onMenu, onOpen }: ListTableProps) {
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
      {sorted.map((p, i) => <ProjectRow key={p.id} p={p} onMenu={onMenu} onOpen={onOpen} last={i === sorted.length - 1} />)}
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

/* Two-step New-project sheet. Step 1 picks the type. For Code projects, step 2
   has no "blank": you either Open an existing folder (that folder IS the project,
   named from its folder name) or Clone a repo into a destination you choose
   (named from the repo). Names auto-fill and de-dupe to "name v1" on collision. */
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

  React.useEffect(() => {
    if (open) { setStep(1); setType('code'); setName(suggestedName ?? ''); setNameEdited(!!suggestedName); setSource('folder'); setRepoUrl(''); setPicked(null); setPickedPath(''); setDestPath(''); setCloneLines([]); setBusy(false); setError(''); }
  }, [open, suggestedName]);

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
        const proj = await api.createProject({ name: name.trim() || baseNameOf(pickedPath), template: 'code', kind: 'coding', path: pickedPath });
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
            </label>

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
      const [apiProjects, pendingGates, budgetData] = await Promise.all([
        api.listProjects(),
        api.listApprovals('pending'),
        api.budget(),
      ]);
      const jobsByProject = await Promise.all(
        apiProjects.map(p => api.listJobs(p.id).catch(() => [] as Job[])),
      );
      const gatesByProject = pendingGates.reduce<Record<string, number>>((acc, g) => {
        if (g.projectId) acc[g.projectId] = (acc[g.projectId] ?? 0) + 1;
        return acc;
      }, {});
      setProjects(apiProjects.map((p, i) => toRow(p, jobsByProject[i] ?? [], gatesByProject[p.id] ?? 0)));
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
                  {projects.map(p => <ProjectCard key={p.id} p={p} onMenu={requestDelete} onOpen={open} />)}
                </div>
              : <ListTable projects={projects} onMenu={requestDelete} onOpen={open} />}
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
