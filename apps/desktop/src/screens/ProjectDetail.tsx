/* Project Detail — ported from the design prototype
   (design/project/project-detail/*.jsx + command-center/{cc-zones,cc-palette}.jsx).
   Header, sticky tab bar, tab router (Overview / Jobs / Instructions / Skills &
   tools / Budget / Settings), command palette, and gate-arrives micro-interaction.
   Visual output (inline styles, classNames, var(--…), SVG, animation classes)
   preserved exactly. Cross-page navigation uses react-router. */

import React from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Icon, type IconName } from '../lib/icons';
import { FileChip, IS_WRITE_TOOL } from '../lib/fileChip';
import {
  GroupedList,
  Row,
  Switch,
  Spinner,
  EffortDial,
  EFFORT_EST,
  EFFORT_META,
  ModelSwitcher,
  ProviderGlyph,
  CountUp,
  type EffortStop,
} from '../lib/ui';
import { ModelPicker, useModelGroups, keyForRoleChoice } from '../lib/ModelPicker';
import { AppShell, useWorkspaceName } from '../lib/appShell';
import { api, IS_LOCAL, type Project, type Job, type Effort, type RepoInfo, type ChatSession, type EngineId, type TranscriptItem } from '../lib/api';

const KIND_LABEL: Record<string, string> = { coding: 'Code', content: 'Content', research: 'Research', general: 'Project' };
function shortHomePath(p: string): string {
  const m = p.match(/^\/Users\/[^/]+\/(.*)$/);
  return m ? `~/${m[1]}` : p;
}

/* Composer theming — the prompt box border/glow takes on the current EFFORT's
   color (--eff-accent), so switching FAST→BALANCED→DEEP→MAX visibly recolors
   the box; MAX gets an animated rainbow border. Exported as its own block so
   ChatThread can inject it itself and the theming works wherever the chat
   renders (the project view AND the multi-project Workspace tabs). */
export const COMPOSER_CSS = `
  .composer-card { position: relative; transition: border-color 220ms ease, box-shadow 220ms ease; }
  .composer-eff { border-color: color-mix(in srgb, var(--eff-accent) 52%, var(--separator-strong)) !important;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--eff-accent) 16%, transparent), 0 6px 22px color-mix(in srgb, var(--eff-accent) 13%, transparent); }
  .composer-eff:focus-within { border-color: color-mix(in srgb, var(--eff-accent) 82%, var(--separator-strong)) !important;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--eff-accent) 18%, transparent), 0 10px 30px color-mix(in srgb, var(--eff-accent) 17%, transparent), var(--card-shadow); }
  @keyframes ultraHue { to { filter: hue-rotate(360deg); } }
  .composer-ultra { border-color: transparent !important; box-shadow: 0 6px 24px color-mix(in srgb, #9b6bff 16%, transparent); }
  .composer-ultra::before {
    content: ''; position: absolute; inset: 0; border-radius: inherit; padding: 1.6px; pointer-events: none;
    background: conic-gradient(from 0deg, #ff5d5d, #ffb44b, #f4e04b, #6bd49a, #41c8d4, #5b8cff, #9b6bff, #ff6b9f, #ff5d5d);
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude;
    animation: ultraHue 6s linear infinite; }
  .composer-ultra:focus-within { box-shadow: 0 0 0 4px color-mix(in srgb, #9b6bff 18%, transparent), 0 10px 30px color-mix(in srgb, #9b6bff 18%, transparent), var(--card-shadow); }
  .send-fab { transition: transform 160ms cubic-bezier(.32,.72,0,1), background 160ms ease, box-shadow 160ms ease; }
  .send-fab:not(:disabled):hover { transform: scale(1.06); }
  .send-fab:not(:disabled):active { transform: scale(.94); }
`;

/* ───────────────── page-specific CSS (from Project Detail.html <style>) ───────────────── */
const PAGE_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes caretBlink { 50% { opacity: 0; } }
  .chat-caret { display:inline-block; width:7px; height:1.05em; margin-left:1px; border-radius:2px;
    background: var(--purple); vertical-align:-2px; animation: caretBlink 1.05s steps(2) infinite; }

  /* message entry — each turn rises in once */
  @keyframes chatRise { from { opacity:0; transform: translateY(7px); } to { opacity:1; transform:none; } }
  .chat-msg { animation: chatRise 320ms cubic-bezier(.32,.72,0,1) both; }

  /* tool node — refined card, lifts on hover, pops on mount */
  @keyframes nodePop { from { opacity:0; transform: translateY(4px) scale(.985); } to { opacity:1; transform:none; } }
  .tool-node { animation: nodePop 240ms cubic-bezier(.32,.72,0,1) both; transition: border-color 160ms ease, background 160ms ease, transform 160ms ease, box-shadow 160ms ease; }
  .tool-node:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(15,20,50,.08); }

  /* "thinking" shimmer text before the first token */
  @keyframes thinkSweep { to { background-position: -200% 0; } }
  .think-shimmer { background: linear-gradient(100deg, var(--ink-tertiary) 30%, var(--ink) 50%, var(--ink-tertiary) 70%);
    background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    animation: thinkSweep 1.5s linear infinite; }

  /* live tool dot — soft glow pulse */
  @keyframes dotGlow { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--purple) 55%, transparent); } 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--purple) 0%, transparent); } }
  .dot-live { animation: dotGlow 1.4s ease-in-out infinite; }

  /* code card — copy button reveals on hover */
  .code-card .code-copy { opacity: 0; transition: opacity 140ms ease; }
  .code-card:hover .code-copy { opacity: 1; }
  .code-copy:hover { color: var(--ink) !important; background: var(--fill-secondary) !important; }

  /* assistant turn — copy-the-reply reveals on hover */
  .turn-copy { opacity: 0; transition: opacity 140ms ease; }
  .chat-msg:hover .turn-copy { opacity: 1; }
  .turn-copy:hover { color: var(--ink) !important; }

  /* example prompt chips (empty state) + question options — never hover when disabled */
  .ex-chip { transition: border-color 150ms ease, background 150ms ease, transform 150ms ease; cursor: pointer; }
  .ex-chip:not(:disabled):hover { border-color: color-mix(in srgb, var(--blue) 55%, var(--separator)) !important; background: color-mix(in srgb, var(--blue) 7%, var(--bg-elevated)) !important; transform: translateY(-1px); }

  /* collapsible "work" toggle — clearly clickable */
  .work-bar { transition: background 140ms ease, border-color 140ms ease; }
  .work-bar:hover { background: var(--fill-secondary) !important; border-color: var(--separator-strong) !important; }

  /* question options — quiet until hovered */
  .opt-row { transition: background 120ms ease; }
  .opt-row:not(:disabled):hover { background: var(--fill-tertiary) !important; }
  .opt-chip { transition: background 120ms ease, border-color 120ms ease, transform 120ms ease; }
  .opt-chip:not(:disabled):hover { border-color: color-mix(in srgb, var(--blue) 55%, var(--separator-strong)) !important; transform: translateY(-1px); }

  /* code card — keep a slim scrollbar visible so long lines read as scrollable */
  .code-card pre::-webkit-scrollbar { height: 7px; }
  .code-card pre::-webkit-scrollbar-thumb { background: var(--separator-strong); border-radius: 4px; }
  .code-card pre::-webkit-scrollbar-track { background: transparent; }

  /* composer — focus glow ring, tinted by the current EFFORT (--eff-accent) */
  ${COMPOSER_CSS}

  /* queued-prompts panel */
  .q-panel { transition: box-shadow 160ms ease; }
  .q-head { transition: background 140ms ease; }
  .q-head:hover { background: var(--fill-tertiary) !important; }
  .q-row { transition: background 120ms ease; }
  .q-row:hover { background: var(--fill-tertiary) !important; }
  .q-row .q-act { opacity: 0; transition: opacity 120ms ease; }
  .q-row:hover .q-act, .q-row.q-sel .q-act { opacity: 1; }
  .q-row.q-sel { background: color-mix(in srgb, var(--blue) 9%, transparent) !important; }
  .q-row .q-grip { opacity: 0; transition: opacity 120ms ease; cursor: grab; }
  .q-row:hover .q-grip, .q-row.q-sel .q-grip { opacity: 1; }
  .q-row.q-dragging { opacity: 0.35; }
  .q-row.q-drop-above { box-shadow: inset 0 2px 0 var(--blue); }
  .q-row.q-drop-below { box-shadow: inset 0 -2px 0 var(--blue); }
  .kbd { display: inline-flex; align-items: center; height: 16px; padding: 0 5px; border-radius: 5px; background: var(--fill-secondary);
    border: 0.5px solid var(--separator); font: 600 10px/1 var(--font-mono); color: var(--ink-secondary); }

  .mm-row { transition: background 120ms ease; }
  .mm-row:hover { background: var(--fill-tertiary); }
  .sess-row { transition: background 140ms ease; }
  .sess-row:hover { background: var(--fill-tertiary); }
  .sess-row .sess-x { opacity: 0; transition: opacity 120ms ease; }
  .sess-row:hover .sess-x { opacity: 1; }
  .sess-x:hover { color: var(--red); }
  .newchat-btn { transition: background 140ms ease, transform 140ms ease; }
  .newchat-btn:hover { background: var(--fill-tertiary); transform: translateY(-1px); }

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
  .crumb:hover { color: var(--blue) !important; }
  .link-btn:hover { text-decoration: underline; }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .split-quiet:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 6%); }
  .step-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 55%, var(--ink) 8%); }
  .send-btn:not(:disabled):hover { transform: scale(1.06); }
  .send-btn:not(:disabled):active { transform: scale(0.95); }

  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

  .sub-card, .recent-row, .filter-chip { transition: background 120ms ease, transform 140ms var(--spring), box-shadow 140ms ease, border-color 140ms ease; }
  .sub-card:hover { transform: translateY(-2px); box-shadow: var(--card-shadow), 0 8px 22px rgba(15,20,60,0.12); border-color: var(--separator-strong); }
  .recent-row:hover { background: var(--fill-tertiary); }
  .filter-chip:hover { filter: brightness(0.97); }

  /* estimate count + cost chip — frozen-clock-safe (no opacity-0 starts) */
  .estimate { animation: estPulse 360ms var(--spring); }
  @keyframes estPulse { 0% { transform: translateY(-2px); } 100% { transform: none; } }
  .cost-chip { animation: chipIn 320ms var(--spring); }
  @keyframes chipIn { 0% { transform: scale(0.9); } 60% { transform: scale(1.04); } 100% { transform: scale(1); } }

  /* gate banner arrival */
  .gate-banner { animation: gateSlide 360ms var(--spring); }
  @keyframes gateSlide { 0% { transform: translateY(-10px); } 100% { transform: none; } }

  /* palette — frozen-clock-safe */
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }

  main::-webkit-scrollbar { width: 9px; }
  main::-webkit-scrollbar-thumb { background: var(--fill-secondary); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }
  textarea::placeholder { color: var(--ink-tertiary); }
  ::selection { background: rgba(0,122,255,0.22); }
`;

/* ───────────────── shared atom: ZoneLabel (from cc-zones.jsx) ───────────────── */
function ZoneLabel({ icon, tint, children }: { icon: IconName; tint: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 11 }}>
      <Icon name={icon} size={15} style={{ color: tint }} />
      <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{children}</span>
    </div>
  );
}

/* ───────────────── command palette (from cc-palette.jsx) ───────────────── */
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

/* ───────────────── shared job atoms (from pd-jobs.jsx) ───────────────── */
type JobStatus = 'running' | 'gated' | 'scheduled' | 'done' | 'failed';

const TRIGGER_ICON: Record<string, IconName> = { hand: 'play', clock: 'clock', chat: 'command', webhook: 'bolt' };
const TRIGGER_LABEL: Record<string, string> = { hand: 'Manual', clock: 'Scheduled', chat: 'From chat', webhook: 'Webhook' };

function JobStatusIcon({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { tint: string; node: React.ReactNode }> = {
    running:   { tint: 'var(--purple)', node: <Spinner size={13} color="var(--purple)" /> },
    gated:     { tint: 'var(--orange)', node: <Icon name="enter" size={15} /> },
    scheduled: { tint: 'var(--teal)',   node: <Icon name="clock" size={15} /> },
    done:      { tint: 'var(--green)',  node: <Icon name="check" size={14} stroke={2.6} /> },
    failed:    { tint: 'var(--red)',    node: <Icon name="x" size={14} stroke={2.6} /> },
  };
  const s = map[status] || map.done;
  return (
    <span style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
      background: `color-mix(in srgb, ${s.tint} 15%, transparent)`, color: s.tint }}>{s.node}</span>
  );
}

const SHAPES: Record<string, { label: string; tint: string }> = {
  single:   { label: 'Single',      tint: 'var(--ink-secondary)' },
  pbr:      { label: 'Plan→Build→Review', tint: 'var(--blue)' },
  fanout:   { label: 'Fan-out',     tint: 'var(--purple)' },
  pipeline: { label: 'Pipeline',    tint: 'var(--teal)' },
};
function ShapeChip({ shape }: { shape: string }) {
  const s = SHAPES[shape] || SHAPES.single;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
      background: `color-mix(in srgb, ${s.tint} 13%, transparent)`, color: s.tint,
      font: '600 var(--fs-caption)/1 var(--font-text)', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <span style={{ width: 5, height: 5, borderRadius: 3, background: s.tint }} />{s.label}
    </span>
  );
}

interface ProjectJob {
  id: string;
  trigger: string;
  name: string;
  shape: string;
  status: JobStatus;
  cost: string;
  started: string;
  duration: string;
}

/* ── live-data adapters: map api.Job → the ProjectJob shape the render expects ── */
const EFFORT_TO_API: Record<EffortStop, Effort> = { FAST: 'fast', BALANCED: 'balanced', DEEP: 'deep', MAX: 'max' };

const API_STATUS_TO_LOCAL: Record<Job['status'], JobStatus> = {
  pending: 'scheduled',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'failed',
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return day === 1 ? 'Yesterday' : `${day} days ago`;
}

function jobDuration(j: Job): string {
  const totalSec = Math.max(0, Math.floor((j.updatedAt - j.createdAt) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toProjectJob(j: Job): ProjectJob {
  return {
    id: j.id,
    trigger: 'hand',
    name: j.title || j.input || 'Untitled job',
    shape: 'single',
    status: API_STATUS_TO_LOCAL[j.status],
    cost: j.cost > 0 ? j.cost.toFixed(2) : '—',
    started: relativeTime(j.createdAt),
    duration: j.status === 'pending' ? '—' : jobDuration(j),
  };
}

const JOB_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'gated', label: 'Gated' },
  { key: 'failed', label: 'Failed' },
];

function JobsTab({ jobs }: { jobs: ProjectJob[] }) {
  const [filter, setFilter] = React.useState('all');
  const rows = jobs.filter(j => filter === 'all' || j.status === filter);
  const count = (k: string) => k === 'all' ? jobs.length : jobs.filter(j => j.status === k).length;

  return (
    <div>
      {/* filter chips */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {JOB_FILTERS.map(f => {
          const on = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} className="filter-chip" style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)',
              background: on ? 'var(--blue)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-secondary)',
              font: '600 var(--fs-subhead)/1 var(--font-text)', transition: 'background 140ms ease, color 140ms ease',
            }}>
              {f.label}
              <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--r-pill)',
                background: on ? 'rgba(255,255,255,0.25)' : 'var(--fill-secondary)', color: on ? '#fff' : 'var(--ink-tertiary)',
                font: '700 var(--fs-caption)/18px var(--font-mono)', textAlign: 'center' }}>{count(f.key)}</span>
            </button>
          );
        })}
      </div>

      {/* table */}
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', overflow: 'hidden',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '24px 2fr 1.3fr 1fr 0.8fr 1fr 0.8fr', alignItems: 'center', gap: 14,
          padding: '11px 18px', borderBottom: '0.5px solid var(--separator)', background: 'var(--fill-tertiary)' }}>
          {['', 'Job', 'Shape', 'Status', 'Cost', 'Started', 'Duration'].map((h, i) => (
            <span key={i} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)',
              textAlign: i >= 4 ? 'right' : 'left' }}>{h}</span>
          ))}
        </div>
        {rows.map((j, i) => (
          <div key={j.id} className="recent-row" style={{ display: 'grid', gridTemplateColumns: '24px 2fr 1.3fr 1fr 0.8fr 1fr 0.8fr', alignItems: 'center', gap: 14,
            padding: '12px 18px', borderBottom: i < rows.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer' }}>
            <span title={TRIGGER_LABEL[j.trigger]} style={{ color: 'var(--ink-tertiary)', display: 'grid', placeItems: 'center' }}>
              <Icon name={TRIGGER_ICON[j.trigger]} size={15} />
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <JobStatusIcon status={j.status} />
              <span style={{ font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
            </span>
            <span><ShapeChip shape={j.shape} /></span>
            <span style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: j.status === 'failed' ? 'var(--red)' : j.status === 'gated' ? 'var(--orange)' : 'var(--ink-secondary)', textTransform: 'capitalize' }}>{j.status}</span>
            <span style={{ textAlign: 'right', font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{j.cost === '—' ? '—' : '$' + j.cost}</span>
            <span style={{ textAlign: 'right', font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{j.started}</span>
            <span style={{ textAlign: 'right', font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{j.duration}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────── Overview tab (from pd-overview.jsx) ───────────────── */
interface AutonomyMode { key: string; label: string; hint: string }
const AUTONOMY: AutonomyMode[] = [
  { key: 'plan',   label: 'Plan first', hint: 'Agent proposes a plan; you approve before it runs.' },
  { key: 'gated',  label: 'Gated',      hint: 'Runs freely but stops at merge / publish / spend gates.' },
  { key: 'unatt',  label: 'Unattended', hint: 'Runs end-to-end. Only hard guardrails can stop it.' },
];

function GoalComposer({ projectId, onRun }: { projectId: string | null; onRun: () => void }) {
  const [goal, setGoal] = React.useState('');
  const [effort, setEffort] = React.useState<EffortStop>('BALANCED');
  const [engine, setEngine] = React.useState('auto');
  const [autonomy, setAutonomy] = React.useState('gated');
  const [running, setRunning] = React.useState(false);
  const est = EFFORT_EST[effort];
  const ai = AUTONOMY.findIndex(a => a.key === autonomy);

  const run = async () => {
    const text = goal.trim();
    if (!text || !projectId || running) return;
    setRunning(true);
    try {
      await api.createAndRunJob({
        projectId, input: text || 'New job', effort: EFFORT_TO_API[effort],
        ...(engine === 'claude' || engine === 'codex' ? { engine } : {}),
      });
      setGoal('');
      onRun();
    } catch {
      /* fail soft */
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="composer" style={{
      background: 'var(--bg-elevated)', borderRadius: 20, border: '0.5px solid var(--separator)',
      boxShadow: 'var(--card-shadow)', padding: 20,
    }}>
      {/* text surface */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <textarea
          value={goal} onChange={e => setGoal(e.target.value)} rows={2}
          placeholder="Hand this project a goal…"
          style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent', resize: 'none',
            font: '400 var(--fs-title2)/1.4 var(--font-text)', color: 'var(--ink)', letterSpacing: '-0.01em',
            minHeight: 62, paddingTop: 4,
          }} />
        <button className="send-btn" onClick={run} disabled={!goal.trim() || running} style={{
          width: 44, height: 44, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
          background: goal.trim() ? 'var(--blue)' : 'var(--fill-secondary)',
          color: goal.trim() ? '#fff' : 'var(--ink-tertiary)',
          boxShadow: goal.trim() ? '0 6px 16px rgba(0,122,255,0.34)' : 'none',
          transition: 'all 180ms var(--spring)', marginTop: 6,
        }}>
          <Icon name="arrowRight" size={20} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} />
        </button>
      </div>

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16, paddingTop: 16, borderTop: '0.5px solid var(--separator)', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Effort</span>
          <EffortDial value={effort} onChange={setEffort} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Engine</span>
          <ModelSwitcher value={engine} onChange={setEngine} compact />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Autonomy</span>
          <div style={{ position: 'relative', display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
            <div style={{ position: 'absolute', top: 2, bottom: 2, left: `calc(${ai * 33.333}% + 2px)`, width: `calc(33.333% - 4px)`,
              background: 'var(--bg-elevated)', borderRadius: 7, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
            {AUTONOMY.map(a => (
              <button key={a.key} onClick={() => setAutonomy(a.key)} title={a.hint} style={{
                position: 'relative', zIndex: 1, padding: '6px 13px', font: '700 11px/1 var(--font-text)', letterSpacing: '0.03em',
                color: autonomy === a.key ? 'var(--ink)' : 'var(--ink-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
              }}>{a.label}</button>
            ))}
          </div>
        </div>

        <span style={{ flex: 1 }} />

        {/* effort guide — runs on your subscription, so no per-run dollar estimate */}
        <div style={{ textAlign: 'right' }}>
          <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Depth</div>
          <div key={effort} className="estimate" style={{ font: '600 var(--fs-callout)/1 var(--font-mono)', color: 'var(--ink)' }}>
            ~{est.mins} min <span style={{ color: 'var(--ink-tertiary)', fontWeight: 400 }}>at {effort}</span>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>
        {AUTONOMY[ai].hint}
      </div>
    </div>
  );
}

interface SubProject { id: string; name: string; branch: string; tint: string; spent: number; cap: number; jobs: number }
const SUBPROJECTS: SubProject[] = [
  { id: 's1', name: 'Auth service', branch: 'auth-refactor', tint: 'var(--blue)', spent: 8.20, cap: 20, jobs: 1 },
  { id: 's2', name: 'Rate limiter', branch: 'ratelimit',     tint: 'var(--purple)', spent: 2.10, cap: 15, jobs: 1 },
  { id: 's3', name: 'API docs',     branch: 'docs-site',     tint: 'var(--teal)', spent: 4.60, cap: 10, jobs: 0 },
  { id: 's4', name: 'CI pipeline',  branch: 'ci-hardening',  tint: 'var(--indigo)', spent: 3.50, cap: 12, jobs: 0 },
];

function SubProjects() {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <ZoneLabel icon="gitMerge" tint="var(--blue)">Sub-projects · {SUBPROJECTS.length}</ZoneLabel>
        <span style={{ flex: 1 }} />
        <button className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>
          <Icon name="plus" size={14} stroke={2.4} /> New branch
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(208px, 1fr))', gap: 12 }}>
        {SUBPROJECTS.map(s => {
          const pct = Math.min(100, (s.spent / s.cap) * 100);
          return (
            <div key={s.id} className="sub-card" style={{
              background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
              boxShadow: 'var(--card-shadow)', padding: 14, cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: s.tint, flexShrink: 0 }} />
                <span style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                {s.jobs > 0 && <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--purple)' }} />}
              </div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', marginBottom: 12 }}>
                <Icon name="gitMerge" size={12} /> {s.branch}
              </div>
              <div style={{ height: 4, borderRadius: 2, background: 'var(--fill-secondary)', overflow: 'hidden', marginBottom: 6 }}>
                <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: s.tint }} />
              </div>
              <div style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
                <b style={{ color: 'var(--ink)', fontWeight: 600 }}>${s.spent.toFixed(2)}</b> / ${s.cap}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentJobs({ jobs }: { jobs: ProjectJob[] }) {
  return (
    <div>
      <ZoneLabel icon="jobs" tint="var(--purple)">Recent jobs</ZoneLabel>
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        {jobs.map((j, i) => (
          <div key={j.id} className="recent-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
            borderBottom: i < jobs.length - 1 ? '0.5px solid var(--separator)' : 'none', cursor: 'pointer' }}>
            <JobStatusIcon status={j.status} />
            <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
            <ShapeChip shape={j.shape} />
            <span style={{ width: 56, textAlign: 'right', font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>${j.cost}</span>
            <span style={{ width: 52, textAlign: 'right', font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{j.duration}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────────────── Instructions tab (from pd-tabs.jsx) ───────────────── */
const INSTRUCTION_DOC = `You maintain the Atlas API — a TypeScript service on Fastify + Postgres.

Architecture
Keep handlers thin. Business logic lives in services/, data access in repositories/. Never import a repository directly from a route.

Style
Match the existing code. Prefer composition over inheritance. No new dependencies without noting why in the PR description.

Testing
Every behavioral change ships with a test. Run the suite before opening a PR; a red suite never reaches review.

Pull requests
One concern per PR. Write a plain-language summary a reviewer can skim in 30 seconds. Link the issue.`;

const RESOLVED: { origin: string; tint: string; text: string }[] = [
  { origin: 'Workspace', tint: 'var(--indigo)', text: 'Write plainly. No emoji in code, comments, or PRs. Cite sources for any external claim.' },
  { origin: 'Project', tint: 'var(--blue)', text: 'Maintain the Atlas API — TypeScript, Fastify, Postgres. Thin handlers; logic in services/.' },
  { origin: 'Sub-project', tint: 'var(--purple)', text: 'auth-refactor: migrating sessions to short-lived JWTs. Keep the legacy cookie path until v2 ships.' },
];

const GUARDRAILS: { text: string; origin: string }[] = [
  { text: 'Never publish or deploy without a gate', origin: 'Workspace rule' },
  { text: 'Hard budget cap — stop at $50, no exceptions', origin: 'Project rule' },
  { text: 'Never force-push to main', origin: 'Workspace rule' },
];

function InstructionsTab({ projectId, project, onSaved }: { projectId: string | null; project: Project | null; onSaved: (instructions: string) => void }) {
  const [text, setText] = React.useState(project?.instructions ?? '');
  const [state, setState] = React.useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = React.useRef(project?.instructions ?? '');

  // Re-seed when the project loads/changes.
  React.useEffect(() => {
    setText(project?.instructions ?? '');
    lastSaved.current = project?.instructions ?? '';
    setState('idle');
  }, [project?.id]);

  // Debounced persistence: 700ms after the last keystroke, save via updateProject.
  const onChange = (v: string) => {
    setText(v);
    if (!projectId) return;
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (v === lastSaved.current) { setState('saved'); return; }
      try {
        await api.updateProject(projectId, { instructions: v });
        lastSaved.current = v;
        setState('saved');
        onSaved(v);
      } catch { setState('idle'); }
    }, 700);
  };
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The exact prompt the engine builds (engine.ts): instructions, a separator,
  // then the goal you type for each job.
  const resolvedPreview = (text.trim() ? `${text.trim()}\n\n---\n\n` : '') + '<your goal for the job>';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 20, alignItems: 'start' }}>
      {/* editor */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '0.5px solid var(--separator)' }}>
          <Icon name="terminal" size={16} style={{ color: 'var(--ink-secondary)' }} />
          <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}>instructions.md</span>
          <span style={{ flex: 1 }} />
          {state === 'saving'
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}><Spinner size={11} /> Saving…</span>
            : state === 'saved'
              ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)' }}><span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--green)' }} /> Saved</span>
              : <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Auto-saves</span>}
        </div>
        <textarea value={text} onChange={e => onChange(e.target.value)} spellCheck={false}
          placeholder="Standing instructions for this project — the agent reads these before every job. e.g. the stack, conventions, what to never touch, how to open PRs…"
          style={{
            width: '100%', maxWidth: 680, display: 'block', margin: '0 auto', border: 'none', outline: 'none', background: 'transparent', resize: 'none',
            font: '400 var(--fs-body)/1.7 var(--font-text)', color: 'var(--ink)', padding: '24px 28px', minHeight: 520, boxSizing: 'border-box',
          }} />
      </div>

      {/* resolved rail — honest: exactly what the engine concatenates */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 4 }}>Resolved view</div>
          <div style={{ font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 14 }}>What the agent actually sees, in order, on every run.</div>
          <pre style={{ margin: 0, font: '400 var(--fs-caption)/1.55 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{resolvedPreview}</pre>
        </div>

        {project?.path && (
          <div style={{ background: 'var(--bg-grouped)', borderRadius: 16, border: '0.5px solid var(--separator)', padding: 16,
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
              <Icon name={project.repoUrl ? 'gitMerge' : 'folder'} size={14} style={{ color: 'var(--ink-secondary)' }} />
              <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Workspace folder</span>
            </div>
            <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-mono)', color: 'var(--ink)', wordBreak: 'break-all' }}>{project.path}</div>
            <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 8 }}>Jobs in this project run inside this folder on your Mac.</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────── Skills & tools tab (from pd-tabs.jsx) ───────────────── */
interface SkillDef { name: string; ver: string; on: boolean }
const SKILLS: SkillDef[] = [
  { name: 'TypeScript engineer', ver: '2.4.0', on: true },
  { name: 'PR author', ver: '1.8.1', on: true },
  { name: 'Test writer', ver: '3.0.2', on: true },
  { name: 'Postgres migrator', ver: '1.2.0', on: false },
];
interface McpDef { name: string; scope: string; tint: string; on: boolean }
const MCP: McpDef[] = [
  { name: 'GitHub', scope: 'read-write · 12 tools', tint: 'var(--ink)', on: true },
  { name: 'Postgres (prod)', scope: 'read-only · 3 tools', tint: 'var(--teal)', on: true },
  { name: 'Linear', scope: 'read-only · 5 tools', tint: 'var(--indigo)', on: true },
  { name: 'Sentry', scope: 'read-only · 4 tools', tint: 'var(--orange)', on: false },
];

function SkillRow({ s, last }: { s: SkillDef; last?: boolean }) {
  const [on, setOn] = React.useState(s.on);
  return (
    <Row last={last}>
      <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: 'var(--fill-tertiary)', color: 'var(--blue)', border: '0.5px solid var(--separator)' }}>
        <Icon name="spark" size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{s.name}</span>
          <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)',
            font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)' }}>v{s.ver}</span>
          <span title="Signature verified" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--green)',
            font: '600 var(--fs-caption)/1 var(--font-text)' }}><Icon name="shield" size={13} /></span>
        </span>
      </span>
      <Switch on={on} onChange={setOn} />
    </Row>
  );
}

function McpRow({ m, last }: { m: McpDef; last?: boolean }) {
  const [on, setOn] = React.useState(m.on);
  return (
    <Row last={last}>
      <span style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: `color-mix(in srgb, ${m.tint} 13%, transparent)`, color: m.tint, border: '0.5px solid var(--separator)' }}>
        <Icon name="cpu" size={18} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{m.name}</span>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.2 var(--font-mono)', color: 'var(--ink-secondary)', marginTop: 2 }}>{m.scope}</span>
      </span>
      <Switch on={on} onChange={setOn} />
    </Row>
  );
}

function SkillsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 720 }}>
      <GroupedList header="Starter skills">
        {SKILLS.map((s, i) => <SkillRow key={s.name} s={s} last={i === SKILLS.length - 1} />)}
      </GroupedList>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 12, marginBottom: 12,
          background: 'rgba(255,149,0,0.10)', border: '0.5px solid rgba(255,149,0,0.3)' }}>
          <Icon name="shield" size={18} style={{ color: 'var(--orange)', flexShrink: 0 }} />
          <span style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>
            <b style={{ fontWeight: 600 }}>Deny by default.</b> Agents can only reach the MCP servers you enable here, with the scopes shown.
          </span>
        </div>
        <GroupedList header="Allowed MCP servers" footer={
          <button className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}>
            <Icon name="plus" size={14} stroke={2.4} /> Add from registry
          </button>}>
          {MCP.map((m, i) => <McpRow key={m.name} m={m} last={i === MCP.length - 1} />)}
        </GroupedList>
      </div>
    </div>
  );
}

/* ───────────────── Budget tab (from pd-tabs.jsx) ───────────────── */
interface BudgetBar { name: string; cost: number; tint: string }
const BUDGET_BARS: BudgetBar[] = [
  { name: 'Refactor auth service', cost: 8.40, tint: 'var(--purple)' },
  { name: 'Nightly test suite', cost: 6.10, tint: 'var(--teal)' },
  { name: 'Dependency audit', cost: 4.20, tint: 'var(--blue)' },
  { name: 'OG image generation', cost: 2.90, tint: 'var(--indigo)' },
  { name: 'Misc / chat', cost: 1.30, tint: 'var(--ink-tertiary)' },
];

function BudgetTab() {
  const [cap, setCap] = React.useState(50);
  const spent = 22.90;
  const ring = 2 * Math.PI * 52;
  const frac = Math.min(1, spent / cap);
  const maxBar = Math.max(...BUDGET_BARS.map(b => b.cost));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
      {/* gauge card */}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)',
        padding: 22, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', alignSelf: 'flex-start' }}>This month</div>
        <svg width="180" height="180" viewBox="0 0 128 128" style={{ transform: 'rotate(-90deg)', margin: '14px 0 6px' }}>
          <circle cx="64" cy="64" r="52" fill="none" stroke="var(--fill-secondary)" strokeWidth="11" />
          <circle cx="64" cy="64" r="52" fill="none" stroke={frac >= 0.9 ? 'var(--red)' : frac >= 0.75 ? 'var(--orange)' : 'var(--green)'} strokeWidth="11" strokeLinecap="round"
            strokeDasharray={ring} strokeDashoffset={ring * (1 - frac)} />
        </svg>
        <div style={{ font: '600 var(--fs-title1)/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>${spent.toFixed(2)}</div>
        <div style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 4 }}>of ${cap}.00 cap · {Math.round(frac * 100)}%</div>

        {/* hard cap stepper */}
        <div style={{ width: '100%', marginTop: 20, paddingTop: 18, borderTop: '0.5px solid var(--separator)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
            <Icon name="lock" size={14} style={{ color: 'var(--red)' }} />
            <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Hard cap</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 4, borderRadius: 12, border: '1.5px solid var(--red)',
            background: 'rgba(255,59,48,0.05)' }}>
            <button onClick={() => setCap(c => Math.max(10, c - 5))} className="step-btn" style={{ width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center',
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>−</button>
            <span style={{ flex: 1, textAlign: 'center', font: '600 var(--fs-title2)/1 var(--font-mono)', color: 'var(--ink)' }}>${cap}</span>
            <button onClick={() => setCap(c => Math.min(500, c + 5))} className="step-btn" style={{ width: 38, height: 38, borderRadius: 9, display: 'grid', placeItems: 'center',
              background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 20px/1 var(--font-text)' }}>+</button>
          </div>
          <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 9 }}>
            Jobs stop the moment spend would cross this line. Raising it asks for confirmation.
          </div>
        </div>
      </div>

      {/* per-job bars */}
      <div style={{ background: 'var(--bg-grouped)', borderRadius: 18, border: '0.5px solid var(--separator)', padding: 20,
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 18 }}>Spend by job</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {BUDGET_BARS.map((b, i) => (
            <div key={i}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7 }}>
                <span style={{ flex: 1, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}>{b.name}</span>
                <span style={{ font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>${b.cost.toFixed(2)}</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--fill-secondary)', overflow: 'hidden' }}>
                <div style={{ width: `${(b.cost / maxBar) * 100}%`, height: '100%', borderRadius: 4, background: b.tint }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────── Settings tab (from pd-tabs.jsx) ───────────────── */
function SettingsTab() {
  return (
    <div style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 22 }}>
      <GroupedList header="Project">
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Name</span>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Atlas API</span></Row>
        <Row><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Template</span>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>Code</span></Row>
        <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)' }}>Default branch</span>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>main</span></Row>
      </GroupedList>
      <GroupedList header="Danger zone" footer="Archiving stops all jobs and hides the project. You can restore it within 30 days.">
        <Row last><span style={{ flex: 1, font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--red)' }}>Archive project</span>
          <Icon name="chevronRight" size={16} style={{ color: 'var(--ink-tertiary)' }} /></Row>
      </GroupedList>
    </div>
  );
}

/* ───────────────── page assembly (from pd-app.jsx) ───────────────── */
/* ───────────────── Chat tab — converse with the agent like a chat app ─────────────────
   Each turn is a real Job (sessionId set): the engine streams partial output into
   job.output, so replies render live. Sessions are first-class: rail on the left,
   thread + composer on the right. Claude turns resume their SDK session (full
   context); codex turns carry stitched history. */

/** Tiny copy-to-clipboard control with a momentary ✓ confirmation. */
function CopyButton({ text, className, label = 'Copy' }: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    try { void navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1300); } catch { /* clipboard blocked */ }
  };
  return (
    <button onClick={copy} title={label} className={className} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 7px', borderRadius: 7,
      background: 'transparent', color: copied ? 'var(--green)' : 'var(--ink-tertiary)', cursor: 'pointer',
      font: '600 var(--fs-caption)/1 var(--font-text)', flexShrink: 0 }}>
      <Icon name={copied ? 'check' : 'command'} size={12} stroke={copied ? 2.6 : 2} />
      {copied ? 'Copied' : label}
    </button>
  );
}

/** A code block with a header (language + copy) and a monospace body. */
function CodeCard({ code, lang, keyId }: { code: string; lang?: string; keyId: string }) {
  return (
    <div key={keyId} className="code-card" style={{ margin: '10px 0', borderRadius: 12, overflow: 'hidden',
      border: '0.5px solid var(--separator)', background: 'var(--bg-grouped)' }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 30, padding: '0 8px 0 12px',
        background: 'color-mix(in srgb, var(--ink) 4%, var(--bg-grouped))', borderBottom: '0.5px solid var(--separator)' }}>
        <span style={{ flex: 1, font: '600 var(--fs-caption)/1 var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{lang || 'code'}</span>
        <CopyButton text={code} className="code-copy" />
      </div>
      <pre style={{ margin: 0, padding: '11px 13px', overflowX: 'auto', font: '400 12.5px/1.6 var(--font-mono)', color: 'var(--ink)' }}>{code}</pre>
    </div>
  );
}

/* Path detection — absolute mac paths, ~ paths, and dotted relative files.
   Returned paths are clickable → reveal in Finder. */
const PATH_RE = /(~\/[^\s`'"()<>]+|\/(?:Users|private|tmp|var|opt|usr|home|Applications|System|Library)\/[^\s`'"()<>]+|\b[\w.-]+\/[\w./-]+\.[A-Za-z0-9]{1,6})/g;
const looksLikePath = (s: string): boolean => { PATH_RE.lastIndex = 0; const m = PATH_RE.exec(s.trim()); return !!m && m[0] === s.trim(); };

function PathLink({ path, mono = true }: { path: string; mono?: boolean }) {
  return (
    <button onClick={() => { void api.revealPath(path); }} title="Reveal in Finder" style={{
      display: 'inline', padding: '0 2px', margin: '0 -2px', borderRadius: 4, background: 'transparent', cursor: 'pointer',
      color: 'var(--blue)', font: mono ? '500 0.92em var(--font-mono)' : 'inherit', textDecorationLine: 'underline',
      textDecorationColor: 'color-mix(in srgb, var(--blue) 68%, transparent)', textUnderlineOffset: 2, wordBreak: 'break-all' }}>
      {path}
    </button>
  );
}

/** Split a plain text run, linkifying any file paths inside it. */
function linkifyText(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0, key = 0;
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<PathLink key={`${keyBase}-pl${key++}`} path={m[0]} mono={false} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

/** Inline markdown: **bold**, `code`, and clickable paths. */
function renderInline(text: string, keyBase: string): React.ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).flatMap((seg, i): React.ReactNode[] => {
    if (seg.startsWith('`') && seg.endsWith('`')) {
      const inner = seg.slice(1, -1);
      if (looksLikePath(inner)) return [<PathLink key={`${keyBase}-${i}`} path={inner} />];
      return [<code key={`${keyBase}-${i}`} style={{ padding: '1px 5px', borderRadius: 5, background: 'var(--fill-tertiary)', font: '500 0.92em var(--font-mono)' }}>{inner}</code>];
    }
    if (seg.startsWith('**') && seg.endsWith('**')) {
      return [<b key={`${keyBase}-${i}`} style={{ fontWeight: 650 }}>{seg.slice(2, -2)}</b>];
    }
    return linkifyText(seg, `${keyBase}-${i}`);
  });
}

/* Markdown table helpers. A GFM table is a header row, a `|---|:--:|` separator,
   then body rows — all pipe-delimited. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}
function isSeparatorRow(line: string): boolean {
  if (!line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')));
}
function colAligns(line: string): ('left' | 'center' | 'right')[] {
  return splitRow(line).map(c => { const t = c.replace(/\s/g, ''); const l = t.startsWith(':'), r = t.endsWith(':'); return l && r ? 'center' : r ? 'right' : 'left'; });
}
function MdTable({ header, aligns, rows, kb }: { header: string[]; aligns: ('left' | 'center' | 'right')[]; rows: string[][]; kb: string }) {
  const cols = header.length;
  const cell = (c: string | undefined, ci: number, k: string): React.ReactNode => c == null ? '' : renderInline(c, `${k}-${ci}`);
  return (
    <div style={{ margin: '10px 0 12px', overflowX: 'auto', borderRadius: 10, border: '0.5px solid var(--separator)' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', font: '400 13px/1.5 var(--font-text)' }}>
        <thead>
          <tr>
            {header.map((c, ci) => (
              <th key={ci} style={{ textAlign: aligns[ci] ?? 'left', padding: '7px 12px', background: 'var(--fill-tertiary)', color: 'var(--ink)',
                font: '650 12.5px/1.4 var(--font-text)', borderBottom: '0.5px solid var(--separator-strong)', whiteSpace: 'nowrap', ...(ci ? { borderLeft: '0.5px solid var(--separator)' } : {}) }}>
                {cell(c, ci, `${kb}-h`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} style={{ background: ri % 2 ? 'color-mix(in srgb, var(--fill-tertiary) 35%, transparent)' : 'transparent' }}>
              {Array.from({ length: cols }, (_, ci) => (
                <td key={ci} style={{ textAlign: aligns[ci] ?? 'left', padding: '6px 12px', color: 'var(--ink-secondary)', verticalAlign: 'top',
                  borderTop: '0.5px solid var(--separator)', ...(ci ? { borderLeft: '0.5px solid var(--separator)' } : {}) }}>
                  {cell(r[ci], ci, `${kb}-r${ri}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Block markdown: headings, tables, bullet + numbered lists, paragraphs. */
function renderProse(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  let key = 0;
  const flushPara = () => {
    if (!para.length) return;
    const t = para.join('\n');
    out.push(<p key={`${keyBase}-p${key++}`} style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderInline(t, `${keyBase}-p${key}`)}</p>);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // table: a pipe row immediately followed by a |---|---| separator
    if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flushPara();
      const header = splitRow(line);
      const aligns = colAligns(lines[i + 1]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() && !isSeparatorRow(lines[j])) { rows.push(splitRow(lines[j])); j++; }
      out.push(<MdTable key={`${keyBase}-tb${key++}`} header={header} aligns={aligns} rows={rows} kb={`${keyBase}-tb${key}`} />);
      i = j;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ol = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (h) {
      flushPara();
      const lvl = h[1].length;
      out.push(<div key={`${keyBase}-h${key++}`} style={{ margin: lvl <= 2 ? '14px 0 6px' : '11px 0 5px', font: `700 ${lvl <= 2 ? '15px' : '13.5px'}/1.35 var(--font-display)`, letterSpacing: '-0.01em', color: 'var(--ink)' }}>{renderInline(h[2], `${keyBase}-h${key}`)}</div>);
    } else if (ol) {
      flushPara();
      out.push(
        <div key={`${keyBase}-o${key++}`} style={{ display: 'flex', gap: 8, margin: '0 0 5px', paddingLeft: 4 }}>
          <span style={{ color: 'var(--ink-tertiary)', flexShrink: 0, minWidth: 17, textAlign: 'right', font: '600 var(--fs-footnote)/1.55 var(--font-mono)' }}>{ol[1]}.</span>
          <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderInline(ol[2], `${keyBase}-o${key}`)}</span>
        </div>
      );
    } else if (li) {
      flushPara();
      out.push(
        <div key={`${keyBase}-l${key++}`} style={{ display: 'flex', gap: 8, margin: '0 0 5px', paddingLeft: 4 }}>
          <span style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }}>•</span>
          <span style={{ minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderInline(li[1], `${keyBase}-l${key}`)}</span>
        </div>
      );
    } else if (!line.trim()) {
      flushPara();
    } else {
      para.push(line);
    }
    i++;
  }
  flushPara();
  return out;
}

/** Chat body: ``` fences become code cards; everything else renders as markdown prose. */
function renderChatBody(text: string, keyBase = 'b'): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const fence = /```([a-zA-Z0-9_+-]*)\n?/g;
  let idx = 0, inCode = false, key = 0, lang = '';
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    const chunk = text.slice(idx, m.index);
    if (chunk.trim()) out.push(inCode
      ? <CodeCard key={`${keyBase}-c${key++}`} keyId={`${keyBase}-c${key}`} code={chunk.replace(/\n$/, '')} lang={lang} />
      : <React.Fragment key={`${keyBase}-f${key++}`}>{renderProse(chunk, `${keyBase}-${key}`)}</React.Fragment>);
    if (!inCode) lang = m[1] || '';
    inCode = !inCode;
    idx = m.index + m[0].length;
  }
  const tail = text.slice(idx);
  if (tail.trim()) out.push(inCode
    ? <CodeCard key={`${keyBase}-c${key++}`} keyId={`${keyBase}-c${key}`} code={tail.replace(/\n$/, '')} lang={lang} />
    : <React.Fragment key={`${keyBase}-f${key++}`}>{renderProse(tail, `${keyBase}-${key}`)}</React.Fragment>);
  return out;
}

/* Tool/skill metadata — which glyph + accent tint a tool family reads as. */
const TOOL_META = (name: string): { icon: IconName; tint: string } => {
  const n = name.toLowerCase();
  if (/bash|shell|command|exec|terminal/.test(n)) return { icon: 'terminal', tint: 'var(--blue)' };
  if (/read|write|edit|glob|grep|notebook|file|patch|ls/.test(n)) return { icon: 'folder', tint: 'var(--teal)' };
  if (/web|search|fetch|browser/.test(n)) return { icon: 'telescope', tint: 'var(--indigo)' };
  if (/skill|task|agent|subagent/.test(n)) return { icon: 'spark', tint: 'var(--purple)' };
  return { icon: 'command', tint: 'var(--ink-secondary)' };
};
const fmtToolDur = (ms?: number): string => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);

/** One step in the agent's tool sequence — a crisp, tinted, monospace card. */
function ToolNode({ item, connect }: { item: TranscriptItem; connect: boolean }) {
  const running = item.toolStatus === 'running';
  const error = item.toolStatus === 'error';
  const { icon, tint } = TOOL_META(item.name ?? '');
  const accent = error ? 'var(--red)' : tint;
  const isWrite = IS_WRITE_TOOL(item.name ?? '') && !!item.text;
  return (
    <div style={{ position: 'relative' }}>
      {connect && <span style={{ position: 'absolute', left: 17, top: -7, width: 1.5, height: 7, background: 'var(--separator-strong)' }} />}
      <div className="tool-node" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 11px 7px 8px', borderRadius: 11,
        background: error ? 'color-mix(in srgb, var(--red) 8%, var(--bg-elevated))' : `color-mix(in srgb, ${tint} 9%, var(--bg-elevated))`,
        border: `0.5px solid color-mix(in srgb, ${accent} 30%, var(--separator))` }}>
        <span style={{ width: 22, height: 22, borderRadius: 7, flexShrink: 0, display: 'grid', placeItems: 'center',
          background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}>
          <Icon name={icon} size={13} />
        </span>
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', flexShrink: 0 }}>{item.name}</span>
        {isWrite
          ? <FileChip path={item.text} preview={item.preview} />
          : item.text && <span style={{ flex: 1, minWidth: 0, font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.text}</span>}
        <span style={{ flexShrink: 0, marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {running ? <Spinner size={11} color={tint} />
            : error ? <Icon name="x" size={12} stroke={2.6} style={{ color: 'var(--red)' }} />
            : <>
                <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{fmtToolDur(item.durMs)}</span>
                <Icon name="check" size={11} stroke={2.6} style={{ color: 'var(--green)' }} />
              </>}
        </span>
      </div>
    </div>
  );
}

/** A run of consecutive tool steps, threaded into one sequence. */
function ToolGroup({ items }: { items: TranscriptItem[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, margin: '10px 0' }}>
      {items.map((it, i) => <ToolNode key={i} item={it} connect={i > 0} />)}
    </div>
  );
}

/* ── Claude asks a question → a real, answerable card ─────────────────── */
interface AskOption { label: string; description?: string }
interface AskQuestion { question: string; header?: string; multiSelect?: boolean; options: AskOption[] }

function parseAsk(json?: string): AskQuestion[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const list = Array.isArray(raw.questions) ? raw.questions
      : raw.question ? [raw] : [];
    return (list as Record<string, unknown>[]).map(q => ({
      question: String(q.question ?? q.header ?? 'Pick an option'),
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true || q.allowMultiple === true,
      options: (Array.isArray(q.options) ? q.options : []).map((o): AskOption =>
        typeof o === 'string' ? { label: o } : { label: String((o as AskOption).label ?? ''), description: (o as AskOption).description }),
    })).filter(q => q.options.length > 0);
  } catch { return []; }
}

/** One option as a compact selectable row (used when options carry descriptions). */
function OptionRow({ label, description, on, multi, answered, onPick }: { label: string; description?: string; on: boolean; multi: boolean; answered: boolean; onPick: () => void }) {
  return (
    <button disabled={answered} onClick={onPick} className="opt-row" style={{
      display: 'flex', alignItems: description ? 'flex-start' : 'center', gap: 9, width: '100%', padding: '6px 9px', borderRadius: 9, textAlign: 'left',
      background: on ? 'color-mix(in srgb, var(--blue) 11%, transparent)' : 'transparent', border: '1px solid transparent', cursor: answered ? 'default' : 'pointer' }}>
      <span style={{ width: 15, height: 15, borderRadius: multi ? 4 : 8, flexShrink: 0, marginTop: description ? 2 : 0, display: 'grid', placeItems: 'center',
        border: `1.5px solid ${on ? 'var(--blue)' : 'var(--separator-strong)'}`, background: on ? 'var(--blue)' : 'transparent', color: '#fff', transition: 'all 120ms ease' }}>
        {on && <Icon name="check" size={9} stroke={3.2} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'block', font: '500 13.5px/1.3 var(--font-text)', color: 'var(--ink)' }}>{label}</span>
        {description && <span style={{ display: 'block', font: '400 12px/1.4 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 1 }}>{description}</span>}
      </span>
    </button>
  );
}

function QuestionCard({ ask, onAnswer, answered }: { ask?: string; onAnswer: (text: string) => void; answered: boolean }) {
  const questions = parseAsk(ask);
  const [picked, setPicked] = React.useState<Record<number, Set<string>>>({});
  const [custom, setCustom] = React.useState('');
  if (questions.length === 0) return null;
  const sendCustom = () => { const v = custom.trim(); if (v) { setCustom(''); onAnswer(v); } };

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked(p => {
      const cur = new Set(p[qi] ?? []);
      if (multi) { cur.has(label) ? cur.delete(label) : cur.add(label); }
      else { cur.clear(); cur.add(label); }
      return { ...p, [qi]: cur };
    });
  };
  const submit = () => {
    const parts = questions.map((q, qi) => {
      const sel = [...(picked[qi] ?? [])];
      return sel.length ? `${q.header ?? q.question}: ${sel.join(', ')}` : '';
    }).filter(Boolean);
    if (parts.length) onAnswer(parts.join('\n'));
  };
  const anyPicked = Object.values(picked).some(s => s.size > 0);
  const needsSubmit = questions.some(q => q.multiSelect) || questions.length > 1;

  return (
    <div style={{ margin: '8px 0', borderRadius: 13, padding: '11px 13px', position: 'relative',
      border: '0.5px solid var(--separator)', background: 'var(--bg-grouped)', opacity: answered ? 0.6 : 1 }}>
      <span style={{ position: 'absolute', left: 0, top: 11, bottom: 11, width: 2.5, borderRadius: 2, background: answered ? 'var(--green)' : 'var(--blue)' }} />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 7, font: '600 var(--fs-caption)/1 var(--font-text)', color: answered ? 'var(--green)' : 'var(--ink-tertiary)' }}>
        <Icon name={answered ? 'check' : 'enter'} size={11} stroke={answered ? 2.6 : 2} /> {answered ? 'Answered' : 'Claude is asking'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
        {questions.map((q, qi) => {
          const hasDesc = q.options.some(o => o.description);
          const sel = picked[qi] ?? new Set<string>();
          const onPick = (label: string) => { if (q.multiSelect) toggle(qi, label, true); else { toggle(qi, label, false); if (!needsSubmit) onAnswer(label); } };
          return (
            <div key={qi}>
              <div style={{ font: '600 14px/1.35 var(--font-text)', color: 'var(--ink)', marginBottom: 8 }}>{q.question}</div>
              {hasDesc ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {q.options.map((o, oi) => <OptionRow key={oi} label={o.label} description={o.description} on={sel.has(o.label)} multi={!!q.multiSelect} answered={answered} onPick={() => onPick(o.label)} />)}
                </div>
              ) : (
                // No descriptions → efficient quick-reply chips.
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {q.options.map((o, oi) => {
                    const on = sel.has(o.label);
                    return (
                      <button key={oi} disabled={answered} onClick={() => onPick(o.label)} className="opt-chip" style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 'var(--r-pill)', cursor: answered ? 'default' : 'pointer',
                        background: on ? 'var(--blue)' : 'var(--bg-elevated)', color: on ? '#fff' : 'var(--ink)',
                        border: `1px solid ${on ? 'var(--blue)' : 'var(--separator-strong)'}`, font: '600 13px/1 var(--font-text)' }}>
                        {q.multiSelect && on && <Icon name="check" size={12} stroke={3} />}{o.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {answered ? (
        <div style={{ marginTop: 10, font: '400 11.5px/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>Send another message to change your answer.</div>
      ) : (
        <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {needsSubmit && (
            <button onClick={submit} disabled={!anyPicked} className="send-fab" style={{ alignSelf: 'flex-start', height: 30, padding: '0 15px', borderRadius: 'var(--r-pill)', border: 'none',
              background: anyPicked ? 'var(--blue)' : 'var(--fill-secondary)', color: anyPicked ? '#fff' : 'var(--ink-tertiary)', font: '600 13px/1 var(--font-text)', cursor: anyPicked ? 'pointer' : 'default' }}>
              Send {[...Object.values(picked)].reduce((n, s) => n + s.size, 0) || ''} answer{[...Object.values(picked)].reduce((n, s) => n + s.size, 0) === 1 ? '' : 's'}
            </button>
          )}
          {/* real, inline "type your own answer" — answers the question directly */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={custom} onChange={e => setCustom(e.target.value)} placeholder="Or type your own answer…"
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendCustom(); } }}
              style={{ flex: 1, height: 34, padding: '0 12px', borderRadius: 9, boxSizing: 'border-box',
                border: '1px solid var(--separator-strong)', background: 'var(--bg-elevated)', color: 'var(--ink)', font: '400 13px/1 var(--font-text)' }} />
            <button onClick={sendCustom} disabled={!custom.trim()} className="send-fab" title="Send your answer" style={{
              width: 34, height: 34, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', border: 'none',
              background: custom.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: custom.trim() ? '#fff' : 'var(--ink-tertiary)', cursor: custom.trim() ? 'pointer' : 'default' }}>
              <Icon name="arrowRight" size={16} stroke={2.6} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Collapsible "work" summary shown once a turn is done ──────────────── */
function WorkBar({ toolCount, elapsed, expanded, onToggle, children }: { toolCount: number; elapsed: string; expanded: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div style={{ margin: '2px 0 4px' }}>
      <button onClick={onToggle} className="work-bar" title={expanded ? 'Hide the steps' : 'Show the steps'} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 26, padding: '0 11px 0 8px', borderRadius: 'var(--r-pill)',
        background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', cursor: 'pointer', color: 'var(--ink-secondary)',
        font: '600 var(--fs-caption)/1 var(--font-text)' }}>
        <Icon name="chevronRight" size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 180ms var(--spring)', color: 'var(--ink-tertiary)' }} />
        <Icon name="check" size={12} stroke={2.6} style={{ color: 'var(--green)' }} />
        Worked {elapsed}{toolCount > 0 ? ` · ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : ''}
      </button>
      {expanded && <div style={{ marginTop: 8, paddingLeft: 11, borderLeft: '1.5px solid var(--separator)', opacity: 0.7 }}>{children}</div>}
    </div>
  );
}

const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
/* Live variant: tenths of a second so the running clock feels realtime. */
const fmtDurationLive = (ms: number): string => {
  const s = Math.max(0, ms / 1000);
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
};

function UserBubble({ text }: { text: string }) {
  return (
    <div className="chat-msg" style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: '78%', padding: '10px 14px', borderRadius: '18px 18px 5px 18px',
        background: 'linear-gradient(180deg, color-mix(in srgb, var(--blue) 94%, #fff) 0%, var(--blue) 100%)',
        color: '#fff', font: '400 14px/1.5 var(--font-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        boxShadow: '0 4px 14px color-mix(in srgb, var(--blue) 30%, transparent)' }}>
        {text}
      </div>
    </div>
  );
}


/* One compact, FIXED stat line for a turn. It lives in the message header so it
   stays put (top-right of the message) as the body streams, instead of drifting
   at the bottom. Live numbers roll via CountUp; tinted purple while running. */
function TurnMeta({ job, elapsed, toolCount, live }: { job: Job; elapsed: string; toolCount: number; live: boolean }) {
  const dot = <span style={{ opacity: 0.45 }}>·</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0, whiteSpace: 'nowrap',
      font: '500 var(--fs-caption)/1 var(--font-mono)', color: live ? 'var(--purple)' : 'var(--ink-tertiary)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="clock" size={10} /> {elapsed}</span>
      {job.tokens > 0 && <>{dot}<span><CountUp value={job.tokens} /> tok</span></>}
      {job.cost > 0 && <>{dot}<span>{live ? '~' : ''}$<CountUp value={job.cost} format={n => n.toFixed(job.cost < 1 ? 3 : 2)} /></span></>}
      {toolCount > 0 && <>{dot}<span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="command" size={10} /> <CountUp value={toolCount} /></span></>}
    </span>
  );
}

/** Render a slice of transcript items into blocks (text→prose, tool runs→group,
    ask→question card). Used both live (full) and collapsed (work only). */
/* A reviewer's verdict block (SP3): the second engine's findings + APPROVED /
   NEEDS WORK, tinted green/orange. Fix rounds stream in as normal turns after. */
function ReviewCard({ item }: { item: TranscriptItem }) {
  const needsWork = item.verdict === 'needs-work';
  const tint = needsWork ? 'var(--orange)' : 'var(--green)';
  return (
    <div style={{ margin: '8px 0 2px', border: `0.5px solid color-mix(in srgb, ${tint} 38%, var(--separator))`, borderRadius: 12, background: `color-mix(in srgb, ${tint} 6%, var(--bg-elevated))`, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '0.5px solid var(--separator)' }}>
        <Icon name="shield" size={14} style={{ color: tint, flexShrink: 0 }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Reviewer · {item.name ?? 'review'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', color: tint, textTransform: 'uppercase' }}>{needsWork ? 'Needs work' : 'Approved'}</span>
      </div>
      <div style={{ padding: '6px 12px 8px' }}>{renderChatBody(item.text, 'rvb')}</div>
    </div>
  );
}

function renderTranscript(items: TranscriptItem[], keyPrefix: string, opts: { caretAt?: number; onAnswer?: (t: string) => void; answered?: boolean }): React.ReactNode[] {
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.kind === 'tool') {
      const run: TranscriptItem[] = [];
      while (i < items.length && items[i].kind === 'tool') { run.push(items[i]); i++; }
      blocks.push(<ToolGroup key={`${keyPrefix}g${i}`} items={run} />);
    } else if (it.kind === 'ask') {
      blocks.push(<QuestionCard key={`${keyPrefix}q${i}`} ask={it.ask} onAnswer={opts.onAnswer ?? (() => {})} answered={!!opts.answered} />);
      i++;
    } else if (it.kind === 'review') {
      blocks.push(<ReviewCard key={`${keyPrefix}rv${i}`} item={it} />);
      i++;
    } else {
      const idx = i;
      blocks.push(
        <div key={`${keyPrefix}b${idx}`} style={{ margin: idx > 0 ? '4px 0 0' : 0 }}>
          {renderChatBody(it.text, `${keyPrefix}${it.kind === 'result' ? 'r' : 't'}${idx}`)}
          {opts.caretAt === idx && <span className="chat-caret" />}
        </div>
      );
      i++;
    }
  }
  return blocks;
}

/* React.memo so a ChatPane re-render (typing in the composer, a job event for
   ANOTHER turn) doesn't re-parse the markdown of every settled turn. Only turns
   whose job object actually changed re-render; onRetry/onAnswer are stable. */
const AssistantTurn = React.memo(function AssistantTurn({ job, onRetry, onAnswer, isLast }: { job: Job; onRetry: (input: string) => void; onAnswer: (text: string) => void; isLast: boolean }) {
  const live = job.status === 'running' || job.status === 'pending';
  const engineLabel = job.engine === 'codex' ? 'Codex' : 'Claude Code';
  const provider = job.engine === 'codex' ? 'openai' as const : 'anthropic' as const;
  const transcript = job.transcript ?? [];
  const hasBody = transcript.length > 0 || !!(job.output && job.output.length > 0);

  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(tick, 100); // tenth-of-a-second clock while running
    return () => clearInterval(t);
  }, [live]);
  const elapsedMs = (live ? Date.now() : job.updatedAt) - job.createdAt;
  const elapsed = live ? fmtDurationLive(elapsedMs) : fmtDuration(elapsedMs);

  // The final answer = last text/result block. Everything before it is "work"
  // (narration + tools) that collapses once the turn is done. A turn that ends
  // in a question stays fully expanded — questions are never hidden.
  const hasAsk = transcript.some(t => t.kind === 'ask');
  let finalIdx = -1;
  for (let k = transcript.length - 1; k >= 0; k--) { if (transcript[k].kind === 'text' || transcript[k].kind === 'result') { finalIdx = k; break; } }
  const collapsible = !live && !hasAsk && finalIdx > 0 && transcript.slice(0, finalIdx).some(t => t.kind === 'tool' || t.kind === 'text');
  const [expanded, setExpanded] = React.useState(false);

  const toolCount = transcript.filter(t => t.kind === 'tool').length;
  const replyText = (finalIdx >= 0 ? transcript[finalIdx].text : '') || job.output || '';
  const lastIdx = transcript.length - 1;

  let body: React.ReactNode = null;
  if (transcript.length > 0) {
    if (collapsible) {
      const work = transcript.slice(0, finalIdx);
      const workTools = work.filter(t => t.kind === 'tool').length;
      body = (
        <div style={{ font: '400 14px/1.62 var(--font-text)', color: 'var(--ink)' }}>
          <WorkBar toolCount={workTools} elapsed={elapsed} expanded={expanded} onToggle={() => setExpanded(e => !e)}>
            <div style={{ font: '400 13px/1.55 var(--font-text)' }}>{renderTranscript(work, 'w', { answered: true })}</div>
          </WorkBar>
          <div style={{ marginTop: 6 }}>{renderChatBody(transcript[finalIdx].text, 'fa')}</div>
        </div>
      );
    } else {
      body = (
        <div style={{ font: '400 14px/1.62 var(--font-text)', color: 'var(--ink)' }}>
          {renderTranscript(transcript, 'a', { caretAt: live ? lastIdx : undefined, onAnswer, answered: !isLast })}
        </div>
      );
    }
  } else if (hasBody) {
    body = (
      <div style={{ font: '400 14px/1.62 var(--font-text)', color: 'var(--ink)' }}>
        {renderChatBody(job.output ?? '')}
        {live && <span className="chat-caret" />}
      </div>
    );
  }

  return (
    <div className="chat-msg" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <span style={{ width: 30, height: 30, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', marginTop: 1,
        background: 'var(--bg-elevated)', color: 'var(--ink)', border: '0.5px solid var(--separator)', boxShadow: '0 1px 3px rgba(15,20,50,.06)' }}>
        {live && !hasBody ? <Spinner size={14} color="var(--purple)" /> : <ProviderGlyph provider={provider} size={16} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{engineLabel}</span>
          {job.model && job.model !== job.engine && (
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{job.model}</span>
          )}
          {live && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--purple)' }}>
              <span className="breathe" style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--purple)' }} />
              {hasBody ? 'streaming' : 'thinking'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {(live || job.tokens > 0 || job.cost > 0) && <TurnMeta job={job} elapsed={elapsed} toolCount={toolCount} live={live} />}
          {job.status === 'done' && replyText && <CopyButton text={replyText} className="turn-copy" />}
        </div>
        {body}
        {!hasBody && live && (
          <div style={{ font: '500 14px/1.5 var(--font-text)' }}>
            <span className="think-shimmer">{job.stage || 'Thinking…'}</span>
          </div>
        )}
        {job.status === 'failed' && (
          <div style={{ marginTop: 8, padding: '11px 13px', borderRadius: 11, background: 'color-mix(in srgb, var(--red) 8%, var(--bg-elevated))',
            border: '0.5px solid color-mix(in srgb, var(--red) 32%, transparent)', font: '400 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--ink)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--red)', fontWeight: 600, marginBottom: 4 }}>
              <Icon name="alert" size={13} /> Run failed
            </span>
            <div style={{ color: 'var(--ink-secondary)' }}>{job.error ?? 'Something went wrong.'}</div>
            <button onClick={() => onRetry(job.input)} style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 12px', borderRadius: 'var(--r-pill)',
              background: 'var(--fill-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', cursor: 'pointer' }}>
              <Icon name="arrowRight" size={13} stroke={2.4} style={{ transform: 'rotate(-45deg)' }} /> Retry
            </button>
          </div>
        )}
        {job.status === 'cancelled' && (
          <div style={{ marginTop: 5, display: 'inline-flex', alignItems: 'center', gap: 5, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            <Icon name="x" size={11} stroke={2.4} /> Stopped
          </div>
        )}
      </div>
    </div>
  );
});

/* Collapsible "N queued messages" panel — keyboard-navigable, with row actions.
   Rows are drag-and-droppable (and ⌥↑/⌥↓ move the selected one) so the operator
   can prioritize which task runs next: the drainer always fires queue[0]. */
function QueuePanel({ queue, onSendNow, onRemove, onEdit, onReorder }: { queue: string[]; onSendNow: (i: number) => void; onRemove: (i: number) => void; onEdit: (i: number) => void; onReorder: (from: number, to: number) => void }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [sel, setSel] = React.useState(-1);
  const [dragIdx, setDragIdx] = React.useState(-1);
  const [dropSlot, setDropSlot] = React.useState(-1); // insertion slot 0..queue.length
  // Refs mirror the drag/selection state for the event logic: dragover/drop can
  // fire before React commits the dragstart state, so guards must not lag.
  const dragRef = React.useRef(-1);
  const slotRef = React.useRef(-1);
  const selRef = React.useRef(-1);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { if (sel >= queue.length) { setSel(queue.length - 1); selRef.current = queue.length - 1; } }, [queue.length, sel]);

  const select = (i: number) => { selRef.current = i; setSel(i); };
  const move = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= queue.length || from === to) return;
    onReorder(from, to);
    select(to);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const s = selRef.current;
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); if (s > 0) move(s, s - 1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); if (s >= 0) move(s, s + 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(queue.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, (s < 0 ? queue.length : s) - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (s >= 0) onSendNow(s); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); if (s >= 0) onRemove(s); }
    else if (e.key.toLowerCase() === 'e') { e.preventDefault(); if (s >= 0) onEdit(s); }
    else if (e.key === 'Escape') { e.preventDefault(); select(-1); ref.current?.blur(); }
  };

  const startDrag = (i: number) => { dragRef.current = i; setDragIdx(i); select(i); };
  const overSlot = (slot: number) => { slotRef.current = slot; setDropSlot(slot); };
  const endDrag = () => { dragRef.current = -1; slotRef.current = -1; setDragIdx(-1); setDropSlot(-1); };
  const doDrop = () => {
    const from = dragRef.current, slot = slotRef.current;
    if (from >= 0 && slot >= 0) {
      let to = slot;
      if (to > from) to -= 1; // removing the dragged row shifts later slots left
      move(from, to);
    }
    endDrag();
  };

  const QBtn = ({ title, onClick, color, children }: { title: string; onClick: () => void; color: string; children: React.ReactNode }) => (
    <button title={title} onClick={e => { e.stopPropagation(); onClick(); }} style={{ width: 24, height: 24, borderRadius: 7, display: 'grid', placeItems: 'center', color, cursor: 'pointer', flexShrink: 0 }}>{children}</button>
  );

  return (
    <div ref={ref} tabIndex={0} onKeyDown={onKey} className="q-panel" style={{ marginBottom: 8, borderRadius: 14, outline: 'none', overflow: 'hidden',
      border: '0.5px solid var(--separator)', background: 'var(--bg-grouped)', boxShadow: 'var(--card-shadow)' }}>
      <button className="q-head" onClick={() => setCollapsed(c => !c)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: 'transparent', cursor: 'pointer',
        borderBottom: collapsed ? 'none' : '0.5px solid var(--separator)' }}>
        <Icon name="layers" size={13} style={{ color: 'var(--purple)' }} />
        <span style={{ flex: 1, textAlign: 'left', font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{queue.length} queued message{queue.length === 1 ? '' : 's'}</span>
        <Icon name="chevronDown" size={15} style={{ color: 'var(--ink-tertiary)', transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 180ms var(--spring)' }} />
      </button>
      {!collapsed && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 168, overflowY: 'auto' }}>
            {queue.map((q, i) => {
              const dropCls = dropSlot === i ? ' q-drop-above' : (dropSlot === i + 1 && i === queue.length - 1) ? ' q-drop-below' : '';
              return (
                <div key={i} className={`q-row${sel === i ? ' q-sel' : ''}${dragIdx === i ? ' q-dragging' : ''}${dropCls}`}
                  onClick={() => select(i)} onDoubleClick={() => onEdit(i)}
                  draggable
                  onDragStart={e => { startDrag(i); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* sandbox */ } } }}
                  onDragEnd={endDrag}
                  onDragOver={e => { if (dragRef.current < 0) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; const r = e.currentTarget.getBoundingClientRect(); overSlot(e.clientY < r.top + r.height / 2 ? i : i + 1); }}
                  onDrop={e => { e.preventDefault(); doDrop(); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px 8px 8px', cursor: 'default' }}>
                  <span className="q-grip" title="Drag to reorder" style={{ flexShrink: 0, display: 'grid', gridTemplateColumns: 'repeat(2, 3px)', gap: '2.5px 2px', padding: '3px 1px', color: 'var(--ink-tertiary)' }}>
                    {Array.from({ length: 6 }, (_, d) => <span key={d} style={{ width: 2.5, height: 2.5, borderRadius: 2, background: 'currentColor' }} />)}
                  </span>
                  <span style={{ width: 18, height: 18, borderRadius: 6, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--purple) 13%, transparent)', color: 'var(--purple)', font: '600 10px/1 var(--font-mono)' }}>{i + 1}</span>
                  <span style={{ flex: 1, minWidth: 0, font: '400 13px/1.35 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{q}</span>
                  <span className="q-act" style={{ display: 'inline-flex', gap: 2 }}>
                    <QBtn title="Move up — runs sooner" onClick={() => move(i, i - 1)} color="var(--ink-tertiary)"><Icon name="chevronDown" size={13} style={{ transform: 'rotate(180deg)' }} /></QBtn>
                    <QBtn title="Move down — runs later" onClick={() => move(i, i + 1)} color="var(--ink-tertiary)"><Icon name="chevronDown" size={13} /></QBtn>
                    <QBtn title="Edit (move back to the box)" onClick={() => onEdit(i)} color="var(--ink-tertiary)"><Icon name="arrowLeft" size={13} stroke={2.2} /></QBtn>
                    <QBtn title="Remove" onClick={() => onRemove(i)} color="var(--ink-tertiary)"><Icon name="x" size={13} stroke={2.4} /></QBtn>
                    <QBtn title="Send now — interrupt and steer" onClick={() => onSendNow(i)} color="var(--blue)"><Icon name="arrowRight" size={13} stroke={2.4} style={{ transform: 'rotate(-90deg)' }} /></QBtn>
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '7px 12px', borderTop: '0.5px solid var(--separator)', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="kbd">↑↓</span> navigate</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="kbd">⌥↑↓</span> reorder</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="kbd">E</span> edit</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="kbd">⌫</span> delete</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="kbd">⏎</span> send now</span>
            <span style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="kbd">Esc</span> exit</span>
          </div>
        </>
      )}
    </div>
  );
}

/* The chat itself for ONE {project, session}: streamed thread + composer +
   queue + steer. `sessionId` is the controlled active session (null = a fresh
   chat); on the first send we create a session and report it via
   onSessionCreated so the parent (the project view OR the multi-project
   Workspace tabs) can adopt it. Fills its parent — only the thread scrolls. */

/* Composer slash-commands — type `/` to scaffold a coding instruction. These are
   Maestro's own prompt commands (they work the same whichever engine runs the
   chat), shown in a menu like Claude Code's. */
const SLASH_COMMANDS: { cmd: string; desc: string; template: string }[] = [
  { cmd: 'plan', desc: 'Plan the work before building', template: 'Make a step-by-step plan for: ' },
  { cmd: 'explain', desc: 'Explain how something works', template: 'Explain how this works: ' },
  { cmd: 'fix', desc: 'Find and fix a bug', template: 'Find and fix this bug: ' },
  { cmd: 'test', desc: 'Write tests', template: 'Write tests for: ' },
  { cmd: 'refactor', desc: 'Clean up code, no behavior change', template: 'Refactor this for clarity (no behavior change): ' },
  { cmd: 'review', desc: 'Review code for issues', template: 'Review this code for bugs, security, and clarity: ' },
  { cmd: 'document', desc: 'Write documentation', template: 'Write clear documentation for: ' },
  { cmd: 'optimize', desc: 'Improve performance', template: 'Profile and optimize the performance of: ' },
];

/* Conversation minimap — a slim right-edge rail with one tick per user message.
   Hover reveals a fly-over listing every prompt + the files it touched; clicking
   a tick or a row jumps to that turn. Makes a long chat navigable at a glance. */
function ChatMinimap({ turns, scrollRef }: { turns: Job[]; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const [hover, setHover] = React.useState(false);
  if (turns.length < 2) return null;
  const scrollTo = (id: string) => { scrollRef.current?.querySelector(`[data-turn="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  const fileRefs = (t: Job): string[] => {
    const out: string[] = [];
    for (const it of t.transcript ?? []) {
      if (it.kind === 'tool' && IS_WRITE_TOOL(it.name ?? '') && it.text) {
        const base = (it.text.split('/').pop() ?? '').split(/\s/)[0];
        if (base && !out.includes(base)) out.push(base);
      }
    }
    return out.slice(0, 6);
  };
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'absolute', left: 2, top: 86, bottom: 124, zIndex: 4, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-start', padding: '2px 5px' }}>
        {turns.map(t => (
          <button key={t.id} onClick={() => scrollTo(t.id)} title={t.input.slice(0, 90)}
            style={{ width: hover ? 20 : 14, height: 2.5, borderRadius: 2, background: 'var(--separator-strong)', cursor: 'pointer', transition: 'width 140ms ease, background 140ms ease' }} />
        ))}
      </div>
      {hover && (
        <div style={{ position: 'absolute', left: 24, top: 0, width: 290, maxHeight: '100%', overflowY: 'auto',
          background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 12, boxShadow: 'var(--shadow-lg, 0 18px 50px rgba(15,20,60,0.26))', padding: 6 }}>
          {turns.map((t, i) => {
            const files = fileRefs(t);
            return (
              <button key={t.id} onClick={() => scrollTo(t.id)} className="mm-row"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8, cursor: 'pointer' }}>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ font: '500 var(--fs-footnote)/1.35 var(--font-text)', color: 'var(--ink)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.input}</span>
                </span>
                {files.length > 0 && (
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5, paddingLeft: 18 }}>
                    {files.map(f => <span key={f} style={{ font: '500 10px/1 var(--font-mono)', color: 'var(--blue)', background: 'color-mix(in srgb, var(--blue) 10%, transparent)', padding: '2px 5px', borderRadius: 4 }}>{f}</span>)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ChatThread({ projectId, project, sessionId, onSessionCreated, onTurns, flush, autoFocus }: {
  projectId: string | null;
  project: Project | null;
  sessionId: string | null;
  onSessionCreated?: (session: ChatSession) => void;
  /** Lifts this chat's turns (jobs) to the parent — used by the Workspace's
      "Changed files" panel to read the write-tool activity. */
  onTurns?: (jobs: Job[]) => void;
  flush?: boolean;
  autoFocus?: boolean;
}) {
  const [turns, setTurns] = React.useState<Job[]>([]);
  React.useEffect(() => { onTurns?.(turns); }, [turns]); // eslint-disable-line react-hooks/exhaustive-deps
  const [activeId, setActiveId] = React.useState<string | null>(sessionId);
  const [text, setText] = React.useState('');
  // Primary (coding) + reviewer model. Remembered across the app via localStorage;
  // seeded from the workspace role defaults when the user hasn't chosen yet.
  const modelGroups = useModelGroups();
  const [primaryKey, setPrimaryKeyState] = React.useState<string>(() => { try { return localStorage.getItem('maestro.chat.primary') || ''; } catch { return ''; } });
  const [reviewerKey, setReviewerKeyState] = React.useState<string>(() => { try { return localStorage.getItem('maestro.chat.reviewer') || ''; } catch { return ''; } });
  const setPrimaryKey = (k: string) => { setPrimaryKeyState(k); try { localStorage.setItem('maestro.chat.primary', k); } catch { /* storage unavailable */ } };
  const setReviewerKey = (k: string) => { setReviewerKeyState(k); try { localStorage.setItem('maestro.chat.reviewer', k); } catch { /* storage unavailable */ } };
  const [favorites, setFavorites] = React.useState<string[]>([]);
  React.useEffect(() => { api.getSettings().then(s => setFavorites(s.favoriteModels ?? [])).catch(() => {}); }, []);
  const toggleFavorite = (key: string) => setFavorites(prev => {
    const next = prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key];
    api.setSettings({ favoriteModels: next }).catch(() => {});
    return next;
  });
  // Seed from the workspace defaults once the catalog is known (if unset).
  React.useEffect(() => {
    if (!modelGroups.length || (primaryKey && reviewerKey)) return;
    api.getRoles().then(roles => {
      if (!primaryKey) setPrimaryKeyState(keyForRoleChoice(modelGroups, roles.primary));
      if (!reviewerKey) setReviewerKeyState(roles.reviewer === 'off' ? 'off' : keyForRoleChoice(modelGroups, roles.reviewer));
    }).catch(() => {});
  }, [modelGroups]); // eslint-disable-line react-hooks/exhaustive-deps
  const [effort, setEffort] = React.useState<EffortStop>('BALANCED');
  // Plan mode: agent proposes a plan first (no execution). Persisted per app.
  const [planMode, setPlanModeState] = React.useState(() => { try { return localStorage.getItem('maestro.chat.plan') === '1'; } catch { return false; } });
  // Goal mode: pursue the request autonomously over a long horizon. Mutually
  // exclusive with Plan. Label depends on the primary engine (Codex = "Pursue goal").
  const [goalMode, setGoalModeState] = React.useState(() => { try { return localStorage.getItem('maestro.chat.goal') === '1'; } catch { return false; } });
  const setPlanMode = (on: boolean) => { setPlanModeState(on); try { localStorage.setItem('maestro.chat.plan', on ? '1' : '0'); } catch { /* ignore */ } if (on) { setGoalModeState(false); try { localStorage.setItem('maestro.chat.goal', '0'); } catch { /* ignore */ } } };
  const setGoalMode = (on: boolean) => { setGoalModeState(on); try { localStorage.setItem('maestro.chat.goal', on ? '1' : '0'); } catch { /* ignore */ } if (on) { setPlanModeState(false); try { localStorage.setItem('maestro.chat.plan', '0'); } catch { /* ignore */ } } };
  const primaryProvider = React.useMemo(() => {
    for (const g of modelGroups) { const d = g.models.find(m => m.key === primaryKey); if (d) return d.provider; }
    return 'claude';
  }, [modelGroups, primaryKey]);
  const [sendError, setSendError] = React.useState('');
  const [slashSel, setSlashSel] = React.useState(0);
  const [schedOpen, setSchedOpen] = React.useState(false);
  const [schedNote, setSchedNote] = React.useState('');
  const [queue, setQueue] = React.useState<string[]>([]); // prompts waiting to run after the current turn
  const activeRef = React.useRef<string | null>(activeId);
  activeRef.current = activeId;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickBottom = React.useRef(true);
  const taRef = React.useRef<HTMLTextAreaElement>(null);

  // Controlled active session: follow the parent (tab switch / rail pick / new chat).
  React.useEffect(() => { setActiveId(sessionId); }, [sessionId]);

  // Turns of the open session (ascending — a chat thread). Queue is per-session.
  React.useEffect(() => {
    setQueue([]);
    if (!activeId) { setTurns([]); return; }
    let alive = true;
    api.listJobs(undefined, activeId)
      .then(js => { if (alive) setTurns([...js].sort((a, b) => a.createdAt - b.createdAt)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [activeId]);

  // LIVE: streamed job updates for this session land directly in the thread.
  React.useEffect(() => {
    const unsub = api.subscribe({
      onJob: (j) => {
        if (!j.sessionId || j.sessionId !== activeRef.current) return;
        setTurns(ts => {
          const i = ts.findIndex(t => t.id === j.id);
          if (i === -1) return [...ts, j].sort((a, b) => a.createdAt - b.createdAt);
          const next = ts.slice(); next[i] = j; return next;
        });
      },
    });
    return unsub;
  }, []);

  // Stick to the bottom while streaming unless the user scrolled up.
  const [atBottom, setAtBottom] = React.useState(true);
  const onScroll = () => {
    const el = scrollRef.current; if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stickBottom.current = bottom;
    setAtBottom(bottom);
  };
  const jumpToLatest = () => {
    const el = scrollRef.current; if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickBottom.current = true; setAtBottom(true);
  };
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  React.useEffect(() => { if (autoFocus) taRef.current?.focus(); }, [autoFocus]);

  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  const streaming = !!lastTurn && (lastTurn.status === 'running' || lastTurn.status === 'pending');

  // The actual send — no guards. Used directly, by the queue drainer, and by steer.
  const sendRaw = React.useCallback(async (raw: string): Promise<boolean> => {
    const t = raw.trim();
    if (!t || !projectId) return false;
    setSendError('');
    stickBottom.current = true;
    try {
      const resp = await api.sendChat({
        projectId, text: t, sessionId: activeRef.current ?? undefined,
        effort: EFFORT_TO_API[effort], plan: planMode, goal: goalMode,
        ...(primaryKey ? { modelKey: primaryKey } : {}),
        ...(reviewerKey ? { reviewerKey } : {}),
      });
      if (activeRef.current !== resp.session.id) {
        activeRef.current = resp.session.id; // match the streamed job immediately
        setActiveId(resp.session.id);
        setTurns([resp.job]);
        onSessionCreated?.(resp.session);
      } else {
        setTurns(ts => [...ts.filter(x => x.id !== resp.job.id), resp.job].sort((a, b) => a.createdAt - b.createdAt));
      }
      return true;
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not send — try again.');
      return false;
    }
  }, [projectId, primaryKey, reviewerKey, effort, planMode, goalMode, onSessionCreated]);

  // Send while idle; QUEUE while a turn is running (it fires when the agent finishes).
  const sendText = React.useCallback((raw: string) => {
    const t = raw.trim();
    if (!t || !projectId) return;
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
    if (streaming) { setQueue(q => [...q, t]); return; }
    void sendRaw(t).then(ok => { if (!ok) setText(raw); });
  }, [projectId, streaming, sendRaw]);

  // STEER: interrupt the running turn and send right now (session resumes with context).
  const sendNow = React.useCallback(async (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
    if (lastTurn && (lastTurn.status === 'running' || lastTurn.status === 'pending')) {
      try { await api.cancelJob(lastTurn.id); } catch { /* already gone */ }
    }
    const ok = await sendRaw(t);
    if (!ok) setText(raw);
  }, [lastTurn, sendRaw]);

  const removeFromQueue = (i: number) => setQueue(q => q.filter((_, j) => j !== i));
  // Reorder = reprioritize: the drainer always fires queue[0] next.
  const moveInQueue = (from: number, to: number) => setQueue(q => {
    if (from === to || from < 0 || to < 0 || from >= q.length || to >= q.length) return q;
    const next = q.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  });
  const sendQueuedNow = (i: number) => { const t = queue[i]; if (t == null) return; removeFromQueue(i); void sendNow(t); };
  const editQueued = (i: number) => { const t = queue[i]; if (t == null) return; removeFromQueue(i); setText(t); taRef.current?.focus(); requestAnimationFrame(() => autoGrow()); };

  // Drain the queue: when the agent goes idle and items are waiting, fire the next.
  const drainingRef = React.useRef(false);
  React.useEffect(() => {
    if (streaming || queue.length === 0 || drainingRef.current) return;
    drainingRef.current = true;
    const next = queue[0];
    setQueue(q => q.slice(1));
    void sendRaw(next).finally(() => { drainingRef.current = false; });
  }, [streaming, queue, sendRaw]);

  const stop = () => { if (lastTurn) void api.cancelJob(lastTurn.id).catch(() => {}); };

  const autoGrow = () => {
    const el = taRef.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(150, el.scrollHeight) + 'px';
  };
  const fillComposer = (v: string) => { setText(v); taRef.current?.focus(); requestAnimationFrame(autoGrow); };
  // Wait-&-check: schedule a one-shot follow-up that pokes this chat after a delay.
  const scheduleCheck = (delayMs: number, label: string) => {
    setSchedOpen(false);
    if (!projectId) return;
    void api.scheduleCheck({ projectId, sessionId: activeRef.current ?? undefined, prompt: text.trim() || undefined, delayMs })
      .then(() => { setSchedNote(`Check scheduled in ${label}`); setTimeout(() => setSchedNote(''), 3500); })
      .catch(() => {});
  };

  // current effort's accent — themes the composer border/glow (MAX = gradient)
  const effAccent = effort === 'MAX' ? '#9b6bff' : EFFORT_META[effort].tint;

  // Slash-command menu: open while the composer holds just a `/word` token.
  const slashMatch = text.match(/^\/([a-zA-Z]*)$/);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const slashList = slashQuery !== null ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(slashQuery)) : [];
  const slashOpen = slashQuery !== null && slashList.length > 0;
  const slashIdx = Math.min(slashSel, Math.max(0, slashList.length - 1));
  const applySlash = (c: { template: string }) => { setText(c.template); requestAnimationFrame(() => { taRef.current?.focus(); autoGrow(); }); };

  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)', overflow: 'hidden',
      ...(flush ? {} : { borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)' }) }}>
      {/* composer theming travels with the chat so the per-effort border vibes
          everywhere ChatThread renders (project view + Workspace tabs) */}
      <style>{COMPOSER_CSS}</style>
      {/* faint top atmosphere */}
      <div style={{ position: 'absolute', inset: '0 0 auto 0', height: 120, pointerEvents: 'none', zIndex: 0,
        background: 'radial-gradient(80% 100% at 50% 0%, color-mix(in srgb, var(--blue) 6%, transparent), transparent 70%)' }} />
      <div ref={scrollRef} onScroll={onScroll} style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 24px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {turns.length === 0 && (
            <div style={{ padding: '52px 20px 20px', textAlign: 'center' }}>
              <span style={{ width: 56, height: 56, borderRadius: 18, display: 'inline-grid', placeItems: 'center', marginBottom: 16,
                background: 'linear-gradient(160deg, color-mix(in srgb, var(--blue) 18%, transparent), color-mix(in srgb, var(--purple) 16%, transparent))',
                color: 'var(--blue)', boxShadow: '0 8px 22px color-mix(in srgb, var(--blue) 18%, transparent)' }}>
                <Icon name="terminal" size={27} />
              </span>
              <div style={{ font: '700 var(--fs-title1)/1.2 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)', marginBottom: 7 }}>
                What should we build{project?.name ? ` in ${project.name}` : ''}?
              </div>
              <div style={{ font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)', maxWidth: 420, margin: '0 auto 22px' }}>
                Describe it like you'd tell a teammate. The agent works in this project's folder and streams every step here.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 520, margin: '0 auto' }}>
                {['Make a simple todo app with a JS frontend + backend', 'Explain how this repo is structured', 'Add tests for the core logic', 'Find and fix any bugs'].map(ex => (
                  <button key={ex} className="ex-chip" onClick={() => fillComposer(ex)} style={{ padding: '8px 13px', borderRadius: 'var(--r-pill)',
                    background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', textAlign: 'left' }}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={t.id} data-turn={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 22, scrollMarginTop: 14 }}>
              <UserBubble text={t.input} />
              <AssistantTurn job={t} isLast={i === turns.length - 1} onRetry={sendText} onAnswer={sendText} />
            </div>
          ))}
        </div>
      </div>

      {/* conversation minimap — one tick per message; hover for the prompt + file list, click to jump */}
      <ChatMinimap turns={turns} scrollRef={scrollRef} />

      {/* jump-to-latest — appears when scrolled up so new replies aren't missed */}
      {!atBottom && turns.length > 0 && (
        <button onClick={jumpToLatest} className="chat-msg" style={{ position: 'absolute', left: '50%', bottom: 92, transform: 'translateX(-50%)', zIndex: 3,
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', borderRadius: 'var(--r-pill)', cursor: 'pointer',
          background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: '0 6px 18px rgba(15,20,50,.16)',
          font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>
          {streaming ? 'Jump to latest' : 'Latest'} <Icon name="chevronDown" size={14} />
        </button>
      )}

      {/* composer — one floating card */}
      <div style={{ position: 'relative', zIndex: 2, padding: '0 20px 16px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          {sendError && (
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px', borderRadius: 10, background: 'color-mix(in srgb, var(--red) 9%, var(--bg-elevated))',
              font: '500 var(--fs-caption)/1.35 var(--font-text)', color: 'var(--red)' }}><Icon name="alert" size={13} /> {sendError}</div>
          )}
          {queue.length > 0 && (
            <QueuePanel queue={queue} onSendNow={sendQueuedNow} onRemove={removeFromQueue} onEdit={editQueued} onReorder={moveInQueue} />
          )}
          {slashOpen && (
            <div style={{ marginBottom: 8, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 12, boxShadow: 'var(--shadow-lg, 0 18px 50px rgba(15,20,60,0.22))', overflow: 'hidden', padding: 5 }}>
              <div style={{ padding: '4px 9px 5px', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', color: 'var(--ink-tertiary)', textTransform: 'uppercase' }}>Commands</div>
              {slashList.map((c, i) => (
                <button key={c.cmd} onMouseEnter={() => setSlashSel(i)} onClick={() => applySlash(c)}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 9, width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 8, cursor: 'pointer',
                    background: i === slashIdx ? 'var(--fill-tertiary)' : 'transparent' }}>
                  <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--blue)', flexShrink: 0 }}>/{c.cmd}</span>
                  <span style={{ font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>{c.desc}</span>
                </button>
              ))}
            </div>
          )}
          <div className={`composer-card composer-eff${effort === 'MAX' ? ' composer-ultra' : ''}`}
            style={{ borderRadius: 18, border: '1px solid var(--separator-strong)', background: 'var(--bg-elevated)',
            boxShadow: 'var(--card-shadow)', padding: '10px 10px 8px 14px', ['--eff-accent' as string]: effAccent } as React.CSSProperties}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <textarea ref={taRef} value={text} rows={1} onChange={e => { setText(e.target.value); autoGrow(); }}
                onKeyDown={e => {
                  if (slashOpen) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel((slashIdx + 1) % slashList.length); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel((slashIdx - 1 + slashList.length) % slashList.length); return; }
                    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySlash(slashList[slashIdx]); return; }
                    if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (streaming && (e.metaKey || e.ctrlKey)) void sendNow(text); else sendText(text); }
                }}
                placeholder={!projectId ? 'Pick a project first' : streaming ? 'Queue a message… (⏎ queue · ⌘⏎ send now)' : planMode ? 'Describe a goal — I\'ll plan it first…' : turns.length > 0 ? 'Add a follow up…' : 'Message the agent…'}
                title="Enter to send · Shift+Enter for a new line · while running: Enter queues, ⌘Enter sends now"
                disabled={!projectId}
                style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
                  color: 'var(--ink)', font: '400 var(--fs-body)/1.5 var(--font-text)', padding: '6px 0',
                  minHeight: 24, maxHeight: 150, boxSizing: 'content-box' }} />
              {streaming ? (
                <>
                  {text.trim() && (
                    <button onClick={() => sendText(text)} className="send-fab" title="Queue (Enter) — runs when the agent finishes · ⌘Enter to send now" style={{
                      width: 38, height: 38, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', border: 'none',
                      background: 'var(--blue)', color: '#fff', boxShadow: '0 5px 14px color-mix(in srgb, var(--blue) 34%, transparent)', cursor: 'pointer' }}>
                      <Icon name="plus" size={18} stroke={2.6} />
                    </button>
                  )}
                  <button onClick={stop} className="send-fab" title="Stop the run" style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                    background: 'color-mix(in srgb, var(--red) 14%, transparent)', color: 'var(--red)', cursor: 'pointer' }}>
                    <span style={{ width: 12, height: 12, borderRadius: 3.5, background: 'currentColor' }} />
                  </button>
                </>
              ) : (
                <button onClick={() => { void sendText(text); }} disabled={!text.trim() || !projectId} className="send-fab" title="Send (Enter)" style={{
                  width: 38, height: 38, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', border: 'none',
                  background: text.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: text.trim() ? '#fff' : 'var(--ink-secondary)',
                  boxShadow: text.trim() ? '0 5px 14px color-mix(in srgb, var(--blue) 34%, transparent)' : 'none', cursor: text.trim() ? 'pointer' : 'default' }}>
                  <Icon name="arrowRight" size={18} stroke={2.6} style={{ transform: 'rotate(-90deg)' }} />
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
              <ModelPicker compact direction="up" value={primaryKey} onChange={setPrimaryKey} favorites={favorites} onToggleFavorite={toggleFavorite} />
              <ModelPicker compact direction="up" allowOff triggerLabel="Review" value={reviewerKey || 'off'} onChange={setReviewerKey} favorites={favorites} onToggleFavorite={toggleFavorite} />
              <EffortDial compact value={effort} onChange={setEffort} />
              <button onClick={() => setPlanMode(!planMode)} title={planMode ? 'Plan mode on — propose before building' : 'Plan first — propose a plan before doing the work'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 9, cursor: 'pointer',
                  background: planMode ? 'color-mix(in srgb, var(--blue) 13%, transparent)' : 'var(--fill-secondary)',
                  border: planMode ? '1px solid color-mix(in srgb, var(--blue) 45%, transparent)' : '1px solid transparent',
                  color: planMode ? 'var(--blue)' : 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                <Icon name="map" size={14} /> Plan
              </button>
              <button onClick={() => setGoalMode(!goalMode)} title={goalMode ? 'Goal mode on — pursue autonomously to completion' : 'Goal mode — pursue the request autonomously over a long run'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: 9, cursor: 'pointer',
                  background: goalMode ? 'color-mix(in srgb, var(--purple) 14%, transparent)' : 'var(--fill-secondary)',
                  border: goalMode ? '1px solid color-mix(in srgb, var(--purple) 45%, transparent)' : '1px solid transparent',
                  color: goalMode ? 'var(--purple)' : 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                <Icon name="target" size={14} /> {primaryProvider === 'codex' ? 'Pursue goal' : 'Goal'}
              </button>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setSchedOpen(o => !o)} title="Schedule a follow-up check — pokes this chat on time"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 28, borderRadius: 9, cursor: 'pointer',
                    background: schedOpen ? 'var(--fill-tertiary)' : 'var(--fill-secondary)', border: '1px solid transparent', color: 'var(--ink-secondary)' }}>
                  <Icon name="clock" size={14} />
                </button>
                {schedOpen && (
                  <>
                    <div onClick={() => setSchedOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                    <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 41, width: 184,
                      background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 11, boxShadow: 'var(--shadow-lg, 0 18px 50px rgba(15,20,60,0.24))', padding: 5 }}>
                      <div style={{ padding: '4px 9px 5px', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Check back in…</div>
                      {[{ label: '15 min', ms: 15 * 60_000 }, { label: '1 hour', ms: 60 * 60_000 }, { label: '3 hours', ms: 3 * 60 * 60_000 }, { label: '6 hours', ms: 6 * 60 * 60_000 }].map(o => (
                        <button key={o.label} onClick={() => scheduleCheck(o.ms, o.label)} className="mm-row"
                          style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 7, cursor: 'pointer', font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {schedNote && <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="check" size={12} /> {schedNote}</span>}
              <span style={{ flex: 1 }} />
              {streaming
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                    <span className="breathe" style={{ width: 5, height: 5, borderRadius: 3, background: 'var(--purple)' }} /> {lastTurn?.stage || 'working…'}
                    <span style={{ color: 'var(--separator-strong)' }}>·</span> ⏎ queue · ⌘⏎ now
                  </span>
                : <span style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{planMode ? 'Plan mode · ⏎ to plan' : queue.length ? `${queue.length} queued` : 'Enter to send · Shift+Enter for newline'}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Per-project chat: a sessions rail + the shared ChatThread. (The multi-project
   Workspace screen wires ChatThread into tabs instead.) */
function ChatPane({ projectId, project }: { projectId: string | null; project: Project | null }) {
  const location = useLocation();
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameVal, setRenameVal] = React.useState('');
  const activeRef = React.useRef<string | null>(null);
  activeRef.current = activeId;

  // Sessions for this project (most recent first; open the latest by default).
  React.useEffect(() => {
    setActiveId(null);
    if (!projectId) { setSessions([]); return; }
    let alive = true;
    const want = new URLSearchParams(location.search).get('s');
    api.listSessions(projectId)
      .then(ss => { if (alive) { setSessions(ss); setActiveId((want && ss.some(x => x.id === want)) ? want : (ss[0]?.id ?? null)); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId, location.search]);

  // LIVE: keep the rail's session list current.
  React.useEffect(() => {
    const unsub = api.subscribe({
      onSession: (s) => {
        if (s.deleted) { setSessions(ss => ss.filter(x => x.id !== s.id)); if (activeRef.current === s.id) setActiveId(null); return; }
        if (projectId && s.projectId !== projectId) return;
        setSessions(ss => {
          const i = ss.findIndex(x => x.id === s.id);
          const next = i === -1 ? [s, ...ss] : ss.map(x => (x.id === s.id ? s : x));
          return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
        });
      },
    });
    return unsub;
  }, [projectId]);

  const removeSession = (id: string) => {
    void api.deleteSession(id).catch(() => {});
    setSessions(ss => ss.filter(s => s.id !== id));
    if (activeRef.current === id) setActiveId(null);
  };
  const commitRename = (id: string) => {
    const title = renameVal.trim();
    setRenamingId(null);
    if (!title) return;
    setSessions(ss => ss.map(s => (s.id === id ? { ...s, title } : s)));
    void api.renameSession(id, title).catch(() => {});
  };

  return (
    <div style={{ display: 'flex', gap: 14, height: 'calc(100vh - 252px)', minHeight: 440 }}>
      {/* sessions rail */}
      <div style={{ width: 236, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-grouped)',
        borderRadius: 18, border: '0.5px solid var(--separator)', overflow: 'hidden', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
        <div style={{ padding: '11px 10px 9px' }}>
          <button onClick={() => setActiveId(null)} className="newchat-btn" title="New chat" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, height: 36, padding: '0 11px', borderRadius: 11,
            background: 'var(--fill-secondary)', color: 'var(--ink)', cursor: 'pointer', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
            <Icon name="plus" size={15} stroke={2.4} style={{ color: 'var(--blue)' }} /> New chat
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sessions.length > 0 && <div style={{ padding: '6px 8px 4px', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Recent</div>}
          {sessions.length === 0 && (
            <div style={{ padding: '22px 12px', font: '400 var(--fs-footnote)/1.55 var(--font-text)', color: 'var(--ink-tertiary)', textAlign: 'center' }}>
              No chats yet.<br />Start one on the right.
            </div>
          )}
          {sessions.map(s => {
            const active = s.id === activeId;
            return (
              <div key={s.id} className="sess-row" onClick={() => setActiveId(s.id)} style={{
                position: 'relative', display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
                background: active ? 'var(--fill-secondary)' : 'transparent' }}>
                {active && <span style={{ position: 'absolute', left: 0, top: 9, bottom: 9, width: 2.5, borderRadius: 2, background: 'var(--blue)' }} />}
                <span style={{ flex: 1, minWidth: 0 }}>
                  {renamingId === s.id ? (
                    <input autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)} onClick={e => e.stopPropagation()}
                      onBlur={() => commitRename(s.id)} onKeyDown={e => { if (e.key === 'Enter') commitRename(s.id); if (e.key === 'Escape') setRenamingId(null); }}
                      style={{ width: '100%', border: '1px solid var(--blue)', borderRadius: 6, padding: '2px 6px', background: 'var(--bg)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1.3 var(--font-text)' }} />
                  ) : (
                    <span onDoubleClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameVal(s.title); }}
                      style={{ display: 'block', font: `${active ? 600 : 500} var(--fs-footnote)/1.3 var(--font-text)`, color: active ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {s.title}
                    </span>
                  )}
                  <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 3 }}>{relativeTime(s.updatedAt)}</span>
                </span>
                <button className="sess-x" title="Delete chat" onClick={e => { e.stopPropagation(); removeSession(s.id); }}
                  style={{ width: 20, height: 20, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', cursor: 'pointer', flexShrink: 0 }}>
                  <Icon name="x" size={12} stroke={2.4} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* thread + composer (shared) */}
      <ChatThread projectId={projectId} project={project} sessionId={activeId}
        onSessionCreated={(s) => { setSessions(ss => (ss.some(x => x.id === s.id) ? ss : [s, ...ss])); setActiveId(s.id); }} />
    </div>
  );
}

const TABS: { key: string; label: string }[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'instructions', label: 'Instructions' },
  { key: 'skills', label: 'Skills & tools' },
  { key: 'budget', label: 'Budget' },
  { key: 'settings', label: 'Settings' },
];

function Breadcrumb({ name }: { name: string }) {
  const navigate = useNavigate();
  const workspaceName = useWorkspaceName();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, font: '500 var(--fs-subhead)/1 var(--font-text)' }}>
      <a onClick={() => navigate('/projects')} className="crumb" style={{ color: 'var(--ink-secondary)', textDecoration: 'none', cursor: 'pointer' }}>{workspaceName}</a>
      <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
      <a onClick={() => navigate('/projects')} className="crumb" style={{ color: 'var(--ink-secondary)', textDecoration: 'none', cursor: 'pointer' }}>Projects</a>
      <Icon name="chevronRight" size={14} style={{ color: 'var(--ink-tertiary)' }} />
      <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{name}</span>
    </div>
  );
}

function GateBanner({ gate, onApprove, onDismiss }: { gate: boolean; onApprove: () => void; onDismiss: () => void }) {
  if (!gate) return null;
  return (
    <div className="gate-banner" style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', marginBottom: 20,
      background: 'var(--bg-elevated)', borderRadius: 14, border: '1px solid rgba(255,149,0,0.4)',
      boxShadow: '0 0 0 4px rgba(255,149,0,0.12), var(--card-shadow)',
    }}>
      <span style={{ width: 36, height: 36, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center',
        background: 'rgba(255,149,0,0.15)', color: 'var(--orange)' }}>
        <Icon name="enter" size={19} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '600 var(--fs-callout)/1.25 var(--font-text)', color: 'var(--ink)' }}>A job is waiting at a gate</span>
        <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Review it in Approvals to let the run continue.</span>
      </span>
      <button onClick={onDismiss} style={{ height: 34, padding: '0 14px', borderRadius: 8, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Dismiss</button>
      <button onClick={onApprove} className="primary-cta" style={{ height: 34, padding: '0 16px', borderRadius: 8, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>Open Approvals</button>
    </div>
  );
}

export default function ProjectDetail() {
  const { id: routeId } = useParams<{ id: string }>();
  const [tab, setTab] = React.useState('chat');
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  // live data
  const [projectId, setProjectId] = React.useState<string | null>(routeId ?? null);
  const [project, setProject] = React.useState<Project | null>(null);
  const [repo, setRepo] = React.useState<RepoInfo | null>(null);
  const [jobs, setJobs] = React.useState<Job[]>([]);

  // Resolve the project id: route param wins, else first project in the workspace.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (routeId) { if (!cancelled) setProjectId(routeId); return; }
      try {
        const projects = await api.listProjects();
        if (!cancelled && projects[0]) setProjectId(projects[0].id);
      } catch { /* fail soft */ }
    })();
    return () => { cancelled = true; };
  }, [routeId]);

  const refetchJobs = React.useCallback(async () => {
    if (!projectId) return;
    try {
      const next = await api.listJobs(projectId);
      setJobs(next);
    } catch { /* fail soft */ }
  }, [projectId]);

  // Load project header + jobs when the id resolves.
  React.useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [p, js] = await Promise.all([api.getProject(projectId), api.listJobs(projectId)]);
        if (cancelled) return;
        setProject(p);
        setJobs(js);
        if (p.path) { api.getProjectRepo(projectId).then(r => { if (!cancelled) setRepo(r); }).catch(() => {}); }
        else setRepo(null);
      } catch { /* fail soft — render empty */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // LIVE: refetch this project's jobs on any job update.
  React.useEffect(() => {
    if (!projectId) return;
    const unsub = api.subscribe({ onJob: () => { void refetchJobs(); } });
    return unsub;
  }, [projectId, refetchJobs]);

  // ⌘K
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const tabIdx = TABS.findIndex(t => t.key === tab);

  const projectJobs = jobs.map(toProjectJob);
  const projectName = project?.name ?? 'Project';
  const projectColor = project?.color ? `var(--${project.color})` : 'var(--blue)';
  const runningCount = jobs.filter(j => j.status === 'running').length;

  return (
    <AppShell active="projects" onSearch={() => setPaletteOpen(true)}>
      <style>{PAGE_CSS}</style>

      {/* header block */}
      <div style={{ padding: '24px 28px 0' }}>
        <Breadcrumb name={projectName} />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <span style={{ width: 52, height: 52, borderRadius: 15, flexShrink: 0, display: 'grid', placeItems: 'center',
            background: `color-mix(in srgb, ${projectColor} 15%, transparent)`, color: projectColor }}>
            <Icon name="terminal" size={28} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h1 style={{ margin: 0, font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{projectName}</h1>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 11px', borderRadius: 'var(--r-pill)',
                background: 'rgba(52,199,89,0.16)', color: 'var(--green)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                <span className="breathe" style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)' }} /> Active · {runningCount} running
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{KIND_LABEL[project?.kind ?? ''] ?? 'Project'}</span>
              {project?.path && (
                <>
                  <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
                  <span title={project.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', maxWidth: 280,
                    background: 'var(--fill-tertiary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>
                    <Icon name={project.repoUrl ? 'gitMerge' : 'folder'} size={12} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortHomePath(project.path)}</span>
                  </span>
                  {repo?.branch && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)',
                      background: 'color-mix(in srgb, var(--purple) 14%, transparent)', color: 'var(--purple)', font: '600 var(--fs-caption)/1 var(--font-mono)' }}>
                      <Icon name="gitMerge" size={11} /> {repo.branch}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {project?.path && IS_LOCAL && (
              <button onClick={() => { if (project?.path) void api.revealPath(project.path); }} className="split-quiet" title="Reveal in Finder" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 15px', borderRadius: 'var(--r-pill)',
                background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>
                <Icon name="folder" size={16} /> Reveal
              </button>
            )}
            <button onClick={() => setPaletteOpen(true)} className="primary-cta" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 40, padding: '0 18px', borderRadius: 'var(--r-pill)',
              background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.30)' }}>
              <Icon name="plus" size={16} stroke={2.4} /> New job
            </button>
          </div>
        </div>
      </div>

      {/* sticky tab bar */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, padding: '14px 28px 12px', marginTop: 18,
        background: 'color-mix(in srgb, var(--bg) 86%, transparent)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '0.5px solid var(--separator)' }}>
        <div style={{ position: 'relative', display: 'inline-flex', padding: 3, background: 'var(--fill-secondary)', borderRadius: 11 }}>
          <div className="tab-pill" style={{ position: 'absolute', top: 3, bottom: 3, left: `${tabIdx * 116 + 3}px`, width: 116,
            background: 'var(--bg-elevated)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)' }} />
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              position: 'relative', zIndex: 1, width: 116, padding: '8px 0', textAlign: 'center',
              font: `${tab === t.key ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`,
              color: tab === t.key ? 'var(--ink)' : 'var(--ink-secondary)', transition: 'color 160ms ease',
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* tab content — chat pins to the viewport; other tabs scroll the page */}
      <div style={{ padding: tab === 'chat' ? '16px 28px 18px' : '22px 28px 36px' }}>
        {tab === 'chat' && <ChatPane projectId={projectId} project={project} />}
        {tab === 'jobs' && <JobsTab jobs={projectJobs} />}
        {tab === 'instructions' && <InstructionsTab projectId={projectId} project={project} onSaved={(ins) => setProject(p => p ? { ...p, instructions: ins } : p)} />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'budget' && <BudgetTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
