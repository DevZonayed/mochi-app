/* Project Templates — gallery ⇄ full-page editor with live preview, clone
   animation, version-history sheet, export toast, and ⌘K command palette.
   Ported from the Babel-standalone prototype (design/project/templates/*) to
   ES-module TypeScript React. Visual output preserved exactly; cross-page
   location.href navigation replaced with react-router useNavigate(). */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Template as ApiTemplate } from '../lib/api';
import { Icon, MaestroMark, type IconName } from '../lib/icons';
import {
  GroupedList,
  Row,
  Switch,
  EffortDial,
  EFFORT_EST,
  type EffortStop,
} from '../lib/ui';
import {
  APP_W,
  APP_H,
  useAppScale,
  useTheme,
  TrafficLights,
  Sidebar,
  Toolbar,
} from '../lib/appShell';

/* Page-specific CSS from the prototype's <style> — drives hover/animation
   classes (.tpl-card, .estimate, .effort-callout, .sheet-pop, .toast, …). */
const PAGE_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }

  .app-wallpaper {
    position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background:
      radial-gradient(60% 50% at 16% 0%, color-mix(in srgb, var(--blob-a) 30%, transparent), transparent 70%),
      radial-gradient(55% 50% at 100% 100%, color-mix(in srgb, var(--blob-b) 26%, transparent), transparent 70%),
      var(--bg);
  }

  .nav-item:hover { background: var(--fill-tertiary); color: var(--ink); }
  .ws-header:hover { background: var(--fill-tertiary); }
  .search-field:hover { background: var(--fill-secondary); }
  .tb-icon:hover { background: var(--fill-secondary); color: var(--ink); }
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .split-quiet:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 6%); }
  .chip-x:hover { background: color-mix(in srgb, currentColor 18%, transparent); }
  .chip-add:hover { background: color-mix(in srgb, var(--fill-secondary) 55%, var(--ink) 8%); color: var(--ink); }

  /* template cards */
  .tpl-card { transition: transform 160ms var(--spring), box-shadow 160ms ease, border-color 160ms ease; }
  .tpl-card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 10px 30px rgba(15,20,60,0.12); border-color: var(--separator-strong); }
  .tpl-card:hover .tpl-actions { opacity: 1; pointer-events: auto; }
  .tpl-card.cloning { animation: cloneSpring 420ms var(--spring); }
  @keyframes cloneSpring { 0% { transform: none; } 45% { transform: translate(10px,10px) scale(0.97); } 100% { transform: none; } }

  /* estimate / callout — frozen-clock-safe */
  .estimate { animation: estPulse 360ms var(--spring); }
  @keyframes estPulse { 0% { transform: translateY(-2px); } 100% { transform: none; } }
  .effort-callout { animation: calloutIn 280ms var(--spring); }
  @keyframes calloutIn { 0% { transform: translateY(-4px); } 100% { transform: none; } }

  /* sheet + toast + palette — frozen-clock-safe */
  .sheet-pop { animation: sheetPop 220ms var(--spring); }
  @keyframes sheetPop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  .toast { animation: toastIn 280ms var(--spring); }
  @keyframes toastIn { from { transform: translate(-50%, 12px); } to { transform: translate(-50%, 0); } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }

  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  main::-webkit-scrollbar { width: 9px; }
  main::-webkit-scrollbar-thumb { background: var(--fill-secondary); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
  textarea::placeholder, input::placeholder { color: var(--ink-tertiary); }
  ::selection { background: rgba(0,122,255,0.22); }
`;

/* ───────────────────────── shared local helper ───────────────────────── */
// ZoneLabel from command-center/cc-zones — small uppercase section header.
function ZoneLabel({ icon, tint, children }: { icon: IconName; tint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11 }}>
      <Icon name={icon} size={15} style={{ color: tint }} />
      <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{children}</span>
    </div>
  );
}

/* ───────────────────────── command palette ───────────────────────── */
interface PaletteItem { group: string; icon: IconName; label: string; hint: string }

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

/* ───────────────────────── data ───────────────────────── */
const EFFORT_BADGE: Record<EffortStop, string> = { FAST: 'var(--green)', BALANCED: 'var(--blue)', DEEP: 'var(--orange)', MAX: 'var(--red)' };

type TriggerKey = 'hand' | 'clock' | 'chat' | 'webhook';

interface Template {
  id: string;
  name: string;
  icon: IconName;
  tint: string;
  ver: string;
  shipped?: boolean;
  draft?: boolean;
  purpose: string;
  effort: EffortStop;
  review: boolean;
  triggers: TriggerKey[];
}

const TEMPLATE_DATA: Template[] = [
  { id: 't1', name: 'Claude', icon: 'spark', tint: 'var(--purple)', ver: '2.1.0', shipped: true,
    purpose: 'General-purpose operator for writing, analysis, and chat.',
    effort: 'BALANCED', review: true, triggers: ['hand', 'chat'] },
  { id: 't2', name: 'Claude Code', icon: 'terminal', tint: 'var(--blue)', ver: '3.4.1', shipped: true,
    purpose: 'Ships code — builds features, runs tests, opens PRs behind a merge gate.',
    effort: 'DEEP', review: true, triggers: ['hand', 'webhook', 'clock'] },
  { id: 't3', name: 'Claude Design', icon: 'brush', tint: 'var(--teal)', ver: '1.2.0', shipped: true,
    purpose: 'Generates and exports brand assets at scale with review gates.',
    effort: 'BALANCED', review: true, triggers: ['hand', 'chat'] },
  { id: 't4', name: 'Research Scout', icon: 'telescope', tint: 'var(--indigo)', ver: '1.0.3', shipped: false,
    purpose: 'Recurring scans and citation-backed digests on a schedule.',
    effort: 'FAST', review: false, triggers: ['clock'] },
  { id: 't5', name: 'Content Studio', icon: 'play', tint: 'var(--orange)', ver: '0.9.0', shipped: false, draft: true,
    purpose: 'Drafts, schedules, and publishes across channels — every post gated.',
    effort: 'BALANCED', review: true, triggers: ['hand', 'clock'] },
  { id: 't6', name: 'Triage Bot', icon: 'bell', tint: 'var(--green)', ver: '1.1.0', shipped: false,
    purpose: 'Auto-labels and routes incoming tickets the moment they land.',
    effort: 'FAST', review: false, triggers: ['webhook', 'chat'] },
];

const TRIG_ICON: Record<TriggerKey, IconName> = { hand: 'play', clock: 'clock', chat: 'command', webhook: 'bolt' };

// Map a live API template into the gallery card shape (fields the API has no
// source for — version/effort/triggers — fall back to sensible defaults).
const ENGINE_TINT: Record<string, string> = {
  'claude-code': 'var(--blue)', 'claude-design': 'var(--teal)', research: 'var(--indigo)',
};
const ENGINE_EFFORT: Record<string, EffortStop> = {
  'claude-code': 'DEEP', 'claude-design': 'BALANCED', research: 'FAST',
};
function fromApiTemplate(t: ApiTemplate): Template {
  return {
    id: t.id,
    name: t.name,
    icon: (t.icon || 'spark') as IconName,
    tint: ENGINE_TINT[t.engine] ?? 'var(--purple)',
    ver: '1.0.0',
    shipped: true,
    purpose: t.description,
    effort: ENGINE_EFFORT[t.engine] ?? 'BALANCED',
    review: true,
    triggers: ['hand'],
  };
}

/* ───────────────────────── gallery ───────────────────────── */
function OriginChip({ shipped }: { shipped?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)',
      background: shipped ? 'color-mix(in srgb, var(--purple) 13%, transparent)' : 'var(--fill-secondary)',
      color: shipped ? 'var(--purple)' : 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)', whiteSpace: 'nowrap' }}>
      {shipped && <MaestroMark size={11} />}{shipped ? 'Maestro' : 'Yours'}
    </span>
  );
}

interface TemplateCardProps {
  t: Template;
  onUse: (id: string) => void;
  onClone: (id: string) => void;
  onEdit: (id: string) => void;
}

function TemplateCard({ t, onUse, onClone, onEdit }: TemplateCardProps) {
  return (
    <div className="tpl-card" data-tpl={t.id} onClick={() => onEdit(t.id)} style={{
      position: 'relative', background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)',
      boxShadow: 'var(--card-shadow)', padding: 16, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 13,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 44, height: 44, borderRadius: 13, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `color-mix(in srgb, ${t.tint} 15%, transparent)`, color: t.tint }}>
          <Icon name={t.icon} size={23} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ font: '600 var(--fs-headline)/1.2 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{t.name}</span>
            <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)',
              font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)' }}>v{t.ver}</span>
            {t.draft && <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'rgba(255,149,0,0.15)',
              font: '600 var(--fs-caption)/18px var(--font-text)', color: 'var(--orange)' }}>Draft</span>}
          </div>
        </div>
        <OriginChip shipped={t.shipped} />
      </div>

      <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty', minHeight: 42 }}>{t.purpose}</p>

      {/* capability footer */}
      <div className="tpl-footer" style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 12, borderTop: '0.5px solid var(--separator)' }}>
        <span title={`${t.effort} effort default`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 'var(--r-pill)',
          background: `color-mix(in srgb, ${EFFORT_BADGE[t.effort]} 13%, transparent)`, color: EFFORT_BADGE[t.effort], font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em' }}>
          <Icon name="gauge" size={12} /> {t.effort}
        </span>
        <span title={t.review ? 'Reviewer on' : 'No reviewer'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
          color: t.review ? 'var(--green)' : 'var(--ink-tertiary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
          <Icon name={t.review ? 'shield' : 'xCircle'} size={14} /> {t.review ? 'Review' : 'No review'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-tertiary)' }}>
          {t.triggers.map(tr => <Icon key={tr} name={TRIG_ICON[tr]} size={14} />)}
        </span>
      </div>

      {/* hover actions */}
      <div className="tpl-actions" style={{ position: 'absolute', inset: 0, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        background: 'color-mix(in srgb, var(--bg-elevated) 80%, transparent)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
        opacity: 0, pointerEvents: 'none', transition: 'opacity 140ms ease' }}>
        <button onClick={e => { e.stopPropagation(); onUse(t.id); }} className="primary-cta" style={{ height: 40, padding: '0 22px', borderRadius: 'var(--r-pill)',
          background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Use</button>
        <button onClick={e => { e.stopPropagation(); onClone(t.id); }} style={{ height: 40, padding: '0 20px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Clone</button>
      </div>
    </div>
  );
}

interface TemplateGalleryViewProps {
  templates: Template[];
  onUse: (id: string) => void;
  onClone: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
}

function TemplateGalleryView({ templates, onUse, onClone, onEdit, onNew, onImport }: TemplateGalleryViewProps) {
  return (
    <main style={{ flex: 1, overflowY: 'auto', padding: '26px 28px 36px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Templates</h1>
          <p style={{ margin: '6px 0 0', font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)', maxWidth: 520 }}>
            The hats your agents wear — saved presets for engine role, effort, skills, and triggers. Clone one to make it yours.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <button onClick={onImport} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 15px', borderRadius: 'var(--r-pill)',
            background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
            <Icon name="enter" size={16} style={{ transform: 'rotate(90deg)' }} /> Import
          </button>
          <button onClick={onNew} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
            background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
            <Icon name="plus" size={16} stroke={2.4} /> New template
          </button>
        </div>
      </div>

      {['Shipped by Maestro', 'Your templates'].map(section => {
        const items = templates.filter(t => section.startsWith('Shipped') ? !!t.shipped : !t.shipped);
        return (
          <div key={section} style={{ marginBottom: 28 }}>
            <ZoneLabel icon={section.startsWith('Shipped') ? 'shield' : 'layers'} tint={section.startsWith('Shipped') ? 'var(--purple)' : 'var(--blue)'}>{section} · {items.length}</ZoneLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(336px, 1fr))', gap: 16 }}>
              {items.map(t => <TemplateCard key={t.id} t={t} onUse={onUse} onClone={onClone} onEdit={onEdit} />)}
            </div>
          </div>
        );
      })}
    </main>
  );
}

/* ───────────────────────── editor ───────────────────────── */
const ICON_CHOICES: IconName[] = ['spark', 'terminal', 'brush', 'telescope', 'play', 'bell', 'bolt', 'cpu', 'layers', 'gauge', 'send', 'shield'];
const COLOR_CHOICES = ['var(--blue)', 'var(--purple)', 'var(--teal)', 'var(--indigo)', 'var(--orange)', 'var(--green)', 'var(--red)'];
const ROLES = [
  { key: 'builder', label: 'Builder', hint: 'Writes and edits' },
  { key: 'driver', label: 'Driver', hint: 'Plans and coordinates' },
  { key: 'subagent', label: 'Subagent', hint: 'Parallel workers' },
  { key: 'reviewer', label: 'Reviewer', hint: 'Checks before gates' },
];

function EditorSection({ n, title, children, sub }: { n: string; title: string; children?: React.ReactNode; sub?: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 12 }}>
        <span style={{ width: 22, height: 22, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '700 var(--fs-caption)/1 var(--font-mono)' }}>{n}</span>
        <h3 style={{ margin: 0, font: '600 var(--fs-headline)/1.2 var(--font-text)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{title}</h3>
        {sub && <span style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function TokenChips({ items, onAdd, onRemove, tint = 'var(--blue)' }: { items: string[]; onAdd: () => void; onRemove: (i: number) => void; tint?: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12, background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)' }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 6px 0 11px', borderRadius: 'var(--r-pill)',
          background: `color-mix(in srgb, ${tint} 12%, transparent)`, color: tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
          {it}
          <button onClick={() => onRemove(i)} className="chip-x" style={{ width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', color: tint }}>
            <Icon name="x" size={11} stroke={2.5} />
          </button>
        </span>
      ))}
      <button onClick={onAdd} className="chip-add" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)',
        background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
        <Icon name="plus" size={13} stroke={2.4} /> Add
      </button>
    </div>
  );
}

function MiniDial({ label, value, onChange }: { label: string; value: EffortStop; onChange: (next: EffortStop) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 64, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', flexShrink: 0 }}>{label}</span>
      <EffortDial value={value} onChange={onChange} compact />
    </div>
  );
}

interface EditorBase {
  name: string;
  icon: IconName;
  tint: string;
  ver: string;
  effort: EffortStop;
  review: boolean;
  triggers: TriggerKey[];
  _cloned?: boolean;
}

interface TemplateEditorProps {
  base: EditorBase;
  onBack: () => void;
  onExport: () => void;
  onHistory: () => void;
  onSave: () => void;
}

function TemplateEditor({ base, onBack, onExport, onHistory, onSave }: TemplateEditorProps) {
  const [name, setName] = React.useState(base.name + (base._cloned ? ' copy' : ''));
  const [icon, setIcon] = React.useState<IconName>(base.icon);
  const [color, setColor] = React.useState(base.tint);
  const [iconOpen, setIconOpen] = React.useState(false);
  const [planE, setPlanE] = React.useState<EffortStop>('BALANCED');
  const [buildE, setBuildE] = React.useState<EffortStop>(base.effort);
  const [reviewE, setReviewE] = React.useState<EffortStop>('FAST');
  const [reviewer, setReviewer] = React.useState(base.review);
  const [skills, setSkills] = React.useState(['TypeScript engineer', 'PR author', 'Test writer']);
  const [tools, setTools] = React.useState(['GitHub', 'Postgres (read-only)']);
  const [triggers, setTriggers] = React.useState<Record<TriggerKey, boolean>>({
    hand: base.triggers.includes('hand'), clock: base.triggers.includes('clock'),
    chat: base.triggers.includes('chat'), webhook: base.triggers.includes('webhook'),
  });

  const addSkill = () => setSkills(s => [...s, 'New skill']);
  const addTool = () => setTools(s => [...s, 'New tool']);

  return (
    <main style={{ flex: 1, overflowY: 'auto' }}>
      {/* editor header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, display: 'flex', alignItems: 'center', gap: 14, padding: '16px 28px',
        background: 'color-mix(in srgb, var(--bg) 86%, transparent)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '0.5px solid var(--separator)' }}>
        <button onClick={onBack} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 13px 0 10px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
          <Icon name="arrowLeft" size={16} /> Templates
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{name || 'Untitled template'}</span>
            <span style={{ height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/20px var(--font-mono)', color: 'var(--ink-secondary)' }}>draft v1.3.0</span>
          </div>
        </div>
        <button onClick={onHistory} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 13px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
          <Icon name="clock" size={15} /> History
        </button>
        <button onClick={onExport} className="split-quiet" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 13px', borderRadius: 'var(--r-pill)',
          background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
          <Icon name="enter" size={15} style={{ transform: 'rotate(-90deg)' }} /> Export
        </button>
        <button onClick={onSave} className="primary-cta" style={{ height: 34, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff',
          font: '600 var(--fs-subhead)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.3)' }}>Save template</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 28, padding: '24px 28px 40px', alignItems: 'start' }}>
        {/* ── left: forms ── */}
        <div style={{ maxWidth: 600 }}>
          {/* 1 identity */}
          <EditorSection n="1" title="Identity">
            <GroupedList>
              <Row>
                <span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>Name</span>
                <input value={name} onChange={e => setName(e.target.value)} style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent',
                  font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)', padding: '13px 0' }} />
              </Row>
              <Row>
                <span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>Icon</span>
                <div style={{ flex: 1, position: 'relative' }}>
                  <button onClick={() => setIconOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 8px', borderRadius: 9, background: 'var(--fill-secondary)' }}>
                    <span style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
                      <Icon name={icon} size={16} />
                    </span>
                    <Icon name="chevronDown" size={14} style={{ color: 'var(--ink-tertiary)' }} />
                  </button>
                  {iconOpen && (
                    <div className="icon-pop" style={{ position: 'absolute', top: 44, left: 0, zIndex: 20, width: 232, padding: 10, borderRadius: 14,
                      background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)',
                      display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
                      {ICON_CHOICES.map(ic => (
                        <button key={ic} onClick={() => { setIcon(ic); setIconOpen(false); }} style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center',
                          background: icon === ic ? `color-mix(in srgb, ${color} 16%, transparent)` : 'var(--fill-tertiary)', color: icon === ic ? color : 'var(--ink-secondary)' }}>
                          <Icon name={ic} size={17} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Row>
              <Row last>
                <span style={{ width: 92, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>Color</span>
                <div style={{ flex: 1, display: 'flex', gap: 8 }}>
                  {COLOR_CHOICES.map(c => (
                    <button key={c} onClick={() => setColor(c)} style={{ width: 26, height: 26, borderRadius: '50%', background: c,
                      boxShadow: color === c ? `0 0 0 2px var(--bg-elevated), 0 0 0 4px ${c}` : 'none', transition: 'box-shadow 140ms ease' }} />
                  ))}
                </div>
              </Row>
            </GroupedList>
          </EditorSection>

          {/* 2 engine & effort */}
          <EditorSection n="2" title="Engine & effort">
            <div style={{ background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', padding: 16 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                {ROLES.map(r => (
                  <span key={r.key} title={r.hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)',
                    background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                    <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--ink-tertiary)' }} />{r.label}
                  </span>
                ))}
              </div>
              <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 16 }}>Roles are routed by config — the engine behind each is chosen per workspace.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
                <MiniDial label="Plan" value={planE} onChange={setPlanE} />
                <MiniDial label="Build" value={buildE} onChange={setBuildE} />
                <MiniDial label="Review" value={reviewE} onChange={setReviewE} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, paddingTop: 14, borderTop: '0.5px solid var(--separator)' }}>
                <span style={{ flex: 1, font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>Reviewer
                  <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>A second pass before any gate.</span>
                </span>
                {reviewer && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)',
                  background: 'rgba(52,199,89,0.16)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}><Icon name="shield" size={13} /> Eval-gated</span>}
                <Switch on={reviewer} onChange={setReviewer} />
              </div>
            </div>
          </EditorSection>

          {/* 3 skills & tools */}
          <EditorSection n="3" title="Starter skills & allowed tools">
            <div style={{ marginBottom: 12 }}>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', padding: '0 2px 7px' }}>Skills</div>
              <TokenChips items={skills} onAdd={addSkill} onRemove={i => setSkills(s => s.filter((_, x) => x !== i))} tint="var(--blue)" />
            </div>
            <div>
              <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', padding: '0 2px 7px' }}>Allowed tools</div>
              <TokenChips items={tools} onAdd={addTool} onRemove={i => setTools(s => s.filter((_, x) => x !== i))} tint="var(--teal)" />
            </div>
          </EditorSection>

          {/* 4 triggers */}
          <EditorSection n="4" title="Allowed triggers">
            <GroupedList>
              {([['hand', 'Manual', 'play'], ['clock', 'Schedule', 'clock'], ['chat', 'Chat message', 'command'], ['webhook', 'Webhook', 'bolt']] as [TriggerKey, string, IconName][]).map(([k, label, ic], i) => (
                <Row key={k} last={i === 3}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink-secondary)' }}>
                    <Icon name={ic} size={16} />
                  </span>
                  <span style={{ flex: 1, font: '500 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)' }}>{label}</span>
                  <Switch on={triggers[k]} onChange={v => setTriggers(t => ({ ...t, [k]: v }))} />
                </Row>
              ))}
            </GroupedList>
          </EditorSection>

          {/* 5 instruction scaffold */}
          <EditorSection n="5" title="Instruction scaffold">
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--r-group)', border: '0.5px solid var(--separator)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '0.5px solid var(--separator)' }}>
                <Icon name="terminal" size={15} style={{ color: 'var(--ink-secondary)' }} />
                <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>scaffold.md</span>
              </div>
              <textarea spellCheck={false} defaultValue={`You are a {{role}} on the {{project}} project.\n\nFollow the workspace and project instructions above this scaffold. Keep changes scoped. When unsure, ask before acting.\n\nDefinition of done\n- {{acceptance_criteria}}\n- Tests pass and a reviewer has signed off.`} style={{
                width: '100%', border: 'none', outline: 'none', background: 'transparent', resize: 'none',
                font: '400 var(--fs-subhead)/1.6 var(--font-mono)', color: 'var(--ink)', padding: '14px 16px', minHeight: 150, boxSizing: 'border-box' }} />
            </div>
          </EditorSection>
        </div>

        {/* ── right: live preview ── */}
        <LivePreview name={name} icon={icon} color={color} buildE={buildE} reviewer={reviewer} triggers={triggers} />
      </div>
    </main>
  );
}

interface LivePreviewProps {
  name: string;
  icon: IconName;
  color: string;
  buildE: EffortStop;
  reviewer: boolean;
  triggers: Record<TriggerKey, boolean>;
}

function LivePreview({ name, icon, color, buildE, reviewer, triggers }: LivePreviewProps) {
  const est = EFFORT_EST[buildE];
  const heavy = buildE === 'DEEP' || buildE === 'MAX';
  const trigList = (Object.entries(triggers) as [TriggerKey, boolean][]).filter(([, v]) => v).map(([k]) => k);
  return (
    <div style={{ position: 'sticky', top: 88 }}>
      <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 12 }}>Live preview</div>

      {/* mini project shell */}
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}>
            <Icon name={icon} size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>New {name || 'template'} project</div>
            <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>Overview preview</div>
          </div>
        </div>

        {/* mini goal composer */}
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', padding: 14 }}>
          <div style={{ font: '400 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginBottom: 14 }}>Hand this project a goal…</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Effort</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
              background: `color-mix(in srgb, ${EFFORT_BADGE[buildE]} 14%, transparent)`, color: EFFORT_BADGE[buildE], font: '700 var(--fs-caption)/1 var(--font-text)' }}>{buildE}</span>
            {reviewer && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--green)', font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={12} /> Review</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTop: '0.5px solid var(--separator)' }}>
            <span key={buildE} className="estimate" style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap' }}>≈ ${est.cost} · ~{est.mins} min</span>
            <span style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--blue)', color: '#fff' }}>
              <Icon name="arrowRight" size={15} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} />
            </span>
          </div>
        </div>

        {/* trigger summary */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Triggers</span>
          <span style={{ display: 'inline-flex', gap: 6, color: 'var(--ink-secondary)' }}>
            {trigList.length ? trigList.map(t => <Icon key={t} name={TRIG_ICON[t]} size={14} />) : <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>None</span>}
          </span>
        </div>
      </div>

      {/* effort callout */}
      {heavy && (
        <div className="effort-callout" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, padding: '12px 14px', borderRadius: 12,
          background: 'rgba(255,149,0,0.10)', border: '0.5px solid rgba(255,149,0,0.35)' }}>
          <Icon name="alert" size={17} style={{ color: 'var(--orange)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>
            <b style={{ fontWeight: 600 }}>{buildE} default ≈ {buildE === 'MAX' ? '5×' : '3×'} cost</b> on every run — sure? Most projects do well on BALANCED.
          </span>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── version history + toast ───────────────────────── */
interface Version { ver: string; date: string; note: string; current?: boolean }

const VERSIONS: Version[] = [
  { ver: '1.2.0', date: 'Mar 14, 2026', note: 'Added PR-author skill; default effort → BALANCED', current: true },
  { ver: '1.1.0', date: 'Feb 2, 2026', note: 'Reviewer made eval-gated' },
  { ver: '1.0.2', date: 'Jan 9, 2026', note: 'Patch: webhook trigger scope' },
  { ver: '1.0.0', date: 'Dec 20, 2025', note: 'First shipped version' },
];

function VersionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div onMouseDown={onClose} style={{ position: 'absolute', inset: 0, zIndex: 80, display: 'grid', placeItems: 'center', padding: 40,
      background: 'rgba(10,12,24,0.32)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)' }}>
      <div onMouseDown={e => e.stopPropagation()} className="sheet-pop" style={{ width: 540, maxHeight: '100%', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--glass-border)', boxShadow: '0 40px 100px rgba(10,15,40,0.5)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '18px 20px', borderBottom: '0.5px solid var(--separator)' }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, font: '700 var(--fs-title2)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Version history</h2>
            <p style={{ margin: '4px 0 0', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>Editing creates v1.3.0. Existing projects keep their snapshot.</p>
          </div>
          <button onClick={onClose} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ padding: 10, overflowY: 'auto' }}>
          {VERSIONS.map((v, i) => (
            <div key={v.ver} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '12px 12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ width: 11, height: 11, borderRadius: 6, background: v.current ? 'var(--blue)' : 'var(--fill-secondary)', border: v.current ? 'none' : '1.5px solid var(--separator-strong)', marginTop: 3 }} />
                {i < VERSIONS.length - 1 && <span style={{ width: 1.5, flex: 1, minHeight: 26, background: 'var(--separator)', marginTop: 4 }} />}
              </div>
              <div style={{ flex: 1, paddingBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>v{v.ver}</span>
                  {v.current && <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)', font: '600 var(--fs-caption)/18px var(--font-text)' }}>Current</span>}
                  <span style={{ flex: 1 }} />
                  <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{v.date}</span>
                </div>
                <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>{v.note}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  React.useEffect(() => { if (msg) { const t = setTimeout(onDone, 2600); return () => clearTimeout(t); } }, [msg]);
  if (!msg) return null;
  return (
    <div className="toast" style={{ position: 'absolute', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 90,
      display: 'inline-flex', alignItems: 'center', gap: 10, height: 44, padding: '0 18px', borderRadius: 'var(--r-pill)',
      background: 'var(--on-glass)', color: 'var(--bg-elevated)', boxShadow: '0 12px 32px rgba(10,15,40,0.4)' }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--green)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon name="check" size={12} stroke={3} style={{ color: '#fff' }} />
      </span>
      <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)' }}>{msg}</span>
    </div>
  );
}

/* ───────────────────────── page root ───────────────────────── */
export default function Templates() {
  const navigate = useNavigate();
  const scale = useAppScale();
  const [theme, setTheme] = useTheme('light');
  const [view, setView] = React.useState<'gallery' | 'editor'>('gallery');
  const [editBase, setEditBase] = React.useState<EditorBase | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [toast, setToast] = React.useState('');
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [templates, setTemplates] = React.useState<Template[]>([]);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  React.useEffect(() => {
    let alive = true;
    api.listTemplates().then(rows => { if (alive) setTemplates(rows.map(fromApiTemplate)); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const byId = (id: string) => templates.find(t => t.id === id)!;
  const toBase = (t: Template, extra?: Partial<EditorBase>): EditorBase => ({
    name: t.name, icon: t.icon, tint: t.tint, ver: t.ver, effort: t.effort, review: t.review, triggers: t.triggers, ...extra,
  });
  const openEditor = (base: EditorBase) => {
    setEditBase(base); setView('editor');
    const m = document.querySelector('main'); if (m) m.scrollTo(0, 0);
  };

  const onEdit = (id: string) => openEditor(toBase(byId(id)));
  const onUse = (id: string) => {
    const t = byId(id);
    if (t) void api.createProject({ name: t.name, template: 'claude-code', color: 'blue' }).catch(() => {});
    navigate('/project-detail');
  };
  const onClone = (id: string) => {
    const card = document.querySelector<HTMLElement>(`[data-tpl="${id}"]`);
    if (card) { card.classList.add('cloning'); setTimeout(() => { card.classList.remove('cloning'); openEditor(toBase(byId(id), { _cloned: true })); }, 420); }
    else openEditor(toBase(byId(id), { _cloned: true }));
  };
  const onNew = () => openEditor({ name: '', icon: 'spark', tint: 'var(--blue)', ver: '0.1.0', effort: 'BALANCED', review: true, triggers: ['hand'] });

  const onNav = (key: string) => navigate('/' + key);

  return (
    <>
      <style>{PAGE_CSS}</style>
      <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
        <div style={{
          width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--bg)',
          display: 'flex',
        }}>
          <div className="app-wallpaper" aria-hidden="true" />
          <TrafficLights />
          <Sidebar active="templates" onNav={onNav} onWorkspace={() => {}} />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
            <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

            {view === 'gallery'
              ? <TemplateGalleryView templates={templates} onUse={onUse} onClone={onClone} onEdit={onEdit} onNew={onNew} onImport={() => setToast('Template imported')} />
              : <TemplateEditor base={editBase!} onBack={() => setView('gallery')} onExport={() => setToast('Template exported')} onHistory={() => setHistoryOpen(true)} onSave={() => { setToast('Saved as v1.3.0'); setView('gallery'); }} />}
          </div>

          <VersionSheet open={historyOpen} onClose={() => setHistoryOpen(false)} />
          <Toast msg={toast} onDone={() => setToast('')} />
          <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        </div>
      </div>
    </>
  );
}
