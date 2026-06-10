/* Projects Overview — grid & list of typed projects, budgets, schedules,
   skeleton-on-load, archive → empty state, template gallery modal, ⌘K palette.
   Ported from the Babel-standalone prototype (design/project/projects/*.jsx +
   command-center/cc-palette.jsx) to an ES-module TypeScript React screen.
   Visual output (inline styles, classNames, var(--…) variables, SVG, animation
   class names) preserved exactly. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import { AppShell, WORKSPACE } from '../lib/appShell';
import { api, type Project as ApiProject, type Job } from '../lib/api';

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
  const hc = health(p.spent, p.cap);
  const pct = p.cap ? Math.min(100, (p.spent / p.cap) * 100) : 0;
  return (
    <div className="proj-card" onClick={() => onOpen && onOpen(p.id)} style={{
      position: 'relative', background: 'var(--bg-elevated)', borderRadius: 20, overflow: 'hidden',
      border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', cursor: 'pointer',
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ height: 3, background: t.tint, flexShrink: 0 }} />
      {p.paused && (
        <div style={{ position: 'absolute', top: 14, right: 14, display: 'inline-flex', alignItems: 'center', gap: 5,
          height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(255,59,48,0.14)', color: 'var(--red)',
          font: '600 var(--fs-caption)/1 var(--font-text)', zIndex: 2 }}>
          <Icon name="pause" size={11} /> Paused — budget cap
        </div>
      )}
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
            <button className="proj-menu" onClick={e => { e.stopPropagation(); onMenu(p.id); }} style={{
              width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0,
            }}><Icon name="more" size={18} /></button>
          )}
        </div>

        {/* status */}
        <StatusLine p={p} />

        {/* budget bar */}
        <div>
          <div style={{ height: 5, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: hc }} />
          </div>
          <div style={{ marginTop: 7, font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
            <b style={{ color: 'var(--ink)', fontWeight: 600 }}>${p.spent.toFixed(2)}</b> / ${p.cap}
          </div>
        </div>

        {/* bottom row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto', paddingTop: 4 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 'var(--r-pill)',
            background: 'var(--fill-tertiary)', font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
            <Icon name="layers" size={12} /> {p.subs} sub
          </span>
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
  const hc = health(p.spent, p.cap);
  const pct = p.cap ? Math.min(100, (p.spent / p.cap) * 100) : 0;
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
        <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--fill-secondary)', overflow: 'hidden', maxWidth: 90 }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: hc }} />
        </div>
        <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap' }}>${p.spent.toFixed(2)}/${p.cap}</span>
      </div>
      <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{p.subs} sub</span>
      <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{p.next === '—' ? p.activity : `Next ${p.next}`}</span>
      <button className="proj-menu" onClick={e => { e.stopPropagation(); onMenu(p.id); }} style={{
        width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
        <Icon name="more" size={18} />
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
  const cols: [string, string | null][] = [['Project', null], ['Status', null], ['Budget', 'spend'], ['Subs', null], ['Schedule', 'activity'], ['', null]];
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

function TemplateGallery({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (template: string) => void }) {
  const [sel, setSel] = React.useState('code');
  React.useEffect(() => { if (open) setSel('code'); }, [open]);
  if (!open) return null;

  const items: GalleryItem[] = [
    { key: 'code',     label: 'Code',     icon: 'terminal',  tint: 'var(--blue)',   blurb: 'Connect a repo. Agents build features, run tests, and open PRs behind a merge gate.' },
    { key: 'design',   label: 'Design',   icon: 'brush',     tint: 'var(--teal)',   blurb: 'Generate and export assets at scale, with brand-review gates before anything ships.' },
    { key: 'content',  label: 'Content',  icon: 'play',      tint: 'var(--purple)', blurb: 'Draft, schedule, and publish across channels — every post waits for your approval.' },
    { key: 'research', label: 'Research', icon: 'telescope', tint: 'var(--indigo)', blurb: 'Run recurring scans and digests with sourced, citation-backed summaries.' },
    { key: 'custom',   label: 'Custom',   icon: 'sliders',   tint: 'var(--ink-secondary)', blurb: 'Start blank. Pick your own tools, schedules, and approval rules.' },
  ];

  return (
    <div onMouseDown={onClose} style={{
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
              <p style={{ margin: '5px 0 0', font: '400 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Templates bundle the tools, schedules, and approval gates a project needs.</p>
            </div>
            <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}>
              <Icon name="x" size={18} />
            </button>
          </div>
        </div>

        <div style={{ padding: 18, overflowY: 'auto', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {items.map(it => {
            const on = sel === it.key;
            return (
              <button key={it.key} onClick={() => setSel(it.key)} style={{
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderTop: '0.5px solid var(--separator)' }}>
          <span style={{ flex: 1, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            You can change tools and gates after creating.
          </span>
          <button onClick={onClose} style={{ height: 40, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Cancel</button>
          <button onClick={() => onCreate(sel)} className="primary-cta" style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Create project</button>
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
  const [view, setView] = React.useState('grid');
  const [loading, setLoading] = React.useState(true);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [budget, setBudget] = React.useState<{ spent: number; cap: number }>({ spent: 0, cap: 200 });
  const [galleryOpen, setGalleryOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

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

  const createProject = async (template: string) => {
    setGalleryOpen(false);
    try {
      const label = TEMPLATES[template]?.label ?? 'New';
      await api.createProject({ name: `${label} Project`, template });
      await load();
    } catch {
      /* fail soft */
    }
  };

  const archive = (id: string) => setProjects(ps => ps.filter(p => p.id !== id));
  const open = () => { navigate('/project-detail'); };

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
      <AppShell active="projects" onSearch={() => setPaletteOpen(true)} budget={{ spent: budget.spent, cap: budget.cap, animateKey: budget.spent }}>
        <div style={{ padding: '26px 28px 32px' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22, gap: 16 }}>
            <div>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Projects</h1>
              <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
                {projects.length} project{projects.length !== 1 ? 's' : ''} in {WORKSPACE}
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
                  {projects.map(p => <ProjectCard key={p.id} p={p} onMenu={archive} onOpen={open} />)}
                </div>
              : <ListTable projects={projects} onMenu={archive} onOpen={open} />}
        </div>
      </AppShell>

      <TemplateGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} onCreate={createProject} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
