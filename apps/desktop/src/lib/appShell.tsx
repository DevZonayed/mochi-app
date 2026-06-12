/* Shared Maestro desktop app chrome: scaled macOS window, frosted sidebar,
   frosted toolbar with traffic lights + budget chip. Used by every app page.
   Ported to ES-module TypeScript React with react-router navigation —
   visual output unchanged. */

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon, MaestroMark } from './icons';
import { NAV_ROUTES, ALL_NAV, pathForNav } from './routes';
import { api } from './api';
import { CountUp } from './ui';

export const APP_W = 1320, APP_H = 860;

export function useAppScale(pad = 40): number {
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    const fit = () => setScale(Math.min((window.innerWidth - pad) / APP_W, (window.innerHeight - pad) / APP_H, 1));
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

export type Theme = 'light' | 'dark';
export type ThemePref = Theme | 'auto';

/* Persisted, app-wide theme. One module-level source of truth: every screen's
   useTheme() reads it and re-renders on change, so the selection survives
   navigation and relaunch ('auto' follows the OS appearance live). */
const THEME_KEY = 'maestro.theme';
const themeListeners = new Set<() => void>();
const themeMedia = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch { /* storage unavailable */ }
  return 'auto';
}
let themePref: ThemePref = readThemePref();

export function getThemePref(): ThemePref { return themePref; }
function resolvedTheme(): Theme { return themePref === 'auto' ? (themeMedia?.matches ? 'dark' : 'light') : themePref; }
function applyTheme(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = resolvedTheme();
  for (const l of themeListeners) l();
}
export function setThemePref(p: ThemePref): void {
  themePref = p;
  try { localStorage.setItem(THEME_KEY, p); } catch { /* storage unavailable */ }
  applyTheme();
}
themeMedia?.addEventListener('change', () => { if (themePref === 'auto') applyTheme(); });
if (typeof document !== 'undefined') document.documentElement.dataset.theme = resolvedTheme();

export function useTheme(_initial: Theme = 'light'): [Theme, React.Dispatch<React.SetStateAction<Theme>>] {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    themeListeners.add(force);
    return () => { themeListeners.delete(force); };
  }, []);
  const setTheme: React.Dispatch<React.SetStateAction<Theme>> = (next) => {
    const value = typeof next === 'function' ? (next as (prev: Theme) => Theme)(resolvedTheme()) : next;
    setThemePref(value);
  };
  return [resolvedTheme(), setTheme];
}

/* Persisted, app-wide sidebar geometry (width + hidden). One module-level source
   so it survives navigation/relaunch and every AppShell instance stays in sync —
   same pattern as the theme above. */
export const SIDEBAR_MIN = 200, SIDEBAR_MAX = 440, SIDEBAR_DEFAULT = 260;
const SIDEBAR_COLLAPSE_AT = 130; // drag narrower than this → hide
const SB_W_KEY = 'maestro.sidebar.width';
const SB_HIDDEN_KEY = 'maestro.sidebar.hidden';
const sbListeners = new Set<() => void>();
function notifySb() { for (const l of sbListeners) l(); }
function clampW(w: number, min = SIDEBAR_MIN): number { return Math.max(min, Math.min(SIDEBAR_MAX, Math.round(w))); }
let sidebarWidth = (() => { try { const v = Number(localStorage.getItem(SB_W_KEY)); return v ? clampW(v) : SIDEBAR_DEFAULT; } catch { return SIDEBAR_DEFAULT; } })();
let sidebarHidden = (() => { try { return localStorage.getItem(SB_HIDDEN_KEY) === '1'; } catch { return false; } })();

export function getSidebarWidth(): number { return sidebarWidth; }
export function getSidebarHidden(): boolean { return sidebarHidden; }
/** Set width during a drag (rawDuring lets it go below MIN while dragging). */
export function setSidebarWidth(w: number, rawDuring = false): void {
  sidebarWidth = rawDuring ? Math.max(0, Math.min(SIDEBAR_MAX, Math.round(w))) : clampW(w);
  notifySb();
}
export function persistSidebarWidth(): void { try { localStorage.setItem(SB_W_KEY, String(sidebarWidth)); } catch { /* ignore */ } }
export function setSidebarHidden(h: boolean): void {
  sidebarHidden = h;
  try { localStorage.setItem(SB_HIDDEN_KEY, h ? '1' : '0'); } catch { /* ignore */ }
  notifySb();
}
export function toggleSidebar(): void { setSidebarHidden(!sidebarHidden); }

let sidebarDragging = false;
export function getSidebarDragging(): boolean { return sidebarDragging; }

/* Drag to resize (from the right-edge handle) OR reveal (from the hidden left
   edge): the sidebar starts at window x=0, so its width follows the cursor X.
   Drag narrower than the threshold and it collapses; release wider clamps to
   [MIN, MAX]. Shared by the handle and the edge hot-zone. */
export function startSidebarDrag(e: React.MouseEvent, opts: { reveal?: boolean } = {}): void {
  e.preventDefault();
  if (opts.reveal) setSidebarHidden(false);
  sidebarDragging = true; notifySb();
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  const onMove = (ev: MouseEvent) => setSidebarWidth(ev.clientX, true);
  const onUp = (ev: MouseEvent) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    sidebarDragging = false;
    if (ev.clientX < SIDEBAR_COLLAPSE_AT) { sidebarWidth = SIDEBAR_DEFAULT; setSidebarHidden(true); }
    else setSidebarWidth(ev.clientX);
    persistSidebarWidth();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

export function useSidebar() {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => { sbListeners.add(force); return () => { sbListeners.delete(force); }; }, []);
  return { width: sidebarWidth, hidden: sidebarHidden, dragging: sidebarDragging, setWidth: setSidebarWidth, setHidden: setSidebarHidden, toggle: toggleSidebar };
}

/** Default workspace name until the live one loads (and for fresh installs). */
export const WORKSPACE = 'Maestro';

/* Live workspace name — one shared, ref-counted fetch for the whole chrome.
   Refreshes on project events (workspace is created lazily with the first one). */
let wsName = WORKSPACE;
let wsRefs = 0;
let wsStop: (() => void) | null = null;
const wsListeners = new Set<() => void>();
function notifyWs() { for (const l of wsListeners) l(); }
function startWsWatch(): () => void {
  const refresh = () => api.listWorkspaces().then(ws => { const n = ws[0]?.name || WORKSPACE; if (n !== wsName) { wsName = n; notifyWs(); } }).catch(() => {});
  refresh();
  const unsub = api.subscribe({ onProject: refresh });
  return () => { unsub(); };
}
export function useWorkspaceName(): string {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    wsListeners.add(force);
    if (wsRefs === 0) wsStop = startWsWatch();
    wsRefs++;
    return () => { wsListeners.delete(force); wsRefs--; if (wsRefs === 0 && wsStop) { wsStop(); wsStop = null; } };
  }, []);
  return wsName;
}

export function TrafficLights() {
  // The native macOS window supplies the real traffic lights (titleBarStyle:
  // hiddenInset). The app now fills the window, so no fake chrome is drawn.
  return null;
}

/* Live pending-approvals count — one shared fetch+subscription for the whole
   chrome (sidebar badge + toolbar bell), ref-counted so it runs once. Refreshes
   on approval/job events and a slow poll. Zero when nothing is waiting. */
let pendingCount = 0;
let pendingRefs = 0;
let pendingStop: (() => void) | null = null;
const pendingListeners = new Set<() => void>();
function notifyPending() { for (const l of pendingListeners) l(); }
function startPendingWatch(): () => void {
  const refresh = () => api.listApprovals('pending').then(a => { if (a.length !== pendingCount) { pendingCount = a.length; notifyPending(); } }).catch(() => {});
  refresh();
  const unsub = api.subscribe({ onApproval: refresh, onJob: refresh });
  const poll = setInterval(refresh, 20000);
  return () => { unsub(); clearInterval(poll); };
}
export function usePendingApprovals(): number {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    pendingListeners.add(force);
    if (pendingRefs === 0) pendingStop = startPendingWatch();
    pendingRefs++;
    return () => {
      pendingListeners.delete(force);
      pendingRefs--;
      if (pendingRefs === 0 && pendingStop) { pendingStop(); pendingStop = null; }
    };
  }, []);
  return pendingCount;
}

export interface SidebarProps {
  active?: string;
  onNav?: (key: string) => void;
  onWorkspace?: () => void;
}

export function Sidebar({ active, onNav, onWorkspace }: SidebarProps) {
  const pending = usePendingApprovals();
  const workspaceName = useWorkspaceName();
  const { width, dragging, toggle } = useSidebar();
  return (
    <aside className="win-drag" style={{
      width, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 2,
      background: 'var(--bg-grouped)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      borderRight: '0.5px solid var(--separator)', transition: dragging ? 'none' : 'width 200ms cubic-bezier(.32,.72,0,1)', overflow: 'hidden',
    }}>
      {/* workspace header */}
      <div style={{ display: 'flex', alignItems: 'center', margin: '46px 6px 10px 10px' }}>
        <button onClick={onWorkspace} style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, textAlign: 'left',
        }} className="ws-header win-no-drag">
          <MaestroMark size={30} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '700 var(--fs-callout)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{workspaceName}</span>
            <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 1 }}>Workspace</span>
          </span>
          <Icon name="chevronDown" size={15} style={{ color: 'var(--ink-tertiary)' }} />
        </button>
        <button onClick={toggle} title="Hide sidebar (⌘B)" className="tb-icon win-no-drag" style={{
          width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0,
        }}>
          <Icon name="sidebar" size={17} />
        </button>
      </div>

      {/* nav */}
      <nav style={{ flex: 1, overflow: 'auto', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {NAV_ROUTES.map(n => {
          const on = active === n.key;
          // Live badge: approvals shows the real pending count, only when > 0.
          const badge = n.key === 'approvals' ? (pending > 0 ? pending : 0) : 0;
          return (
            <button key={n.key} onClick={() => onNav && onNav(n.key)} style={{
              display: 'flex', alignItems: 'center', gap: 11, height: 36, padding: '0 10px', borderRadius: 8, textAlign: 'left',
              background: on ? 'var(--blue)' : 'transparent',
              color: on ? '#fff' : 'var(--ink-secondary)',
              font: `${on ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`,
              transition: 'background 140ms ease, color 140ms ease',
            }} className={on ? '' : 'nav-item'}>
              <Icon name={n.icon} size={18} stroke={on ? 2 : 1.85} />
              <span style={{ flex: 1 }}>{n.label}</span>
              {badge > 0 && (
                <span style={{
                  minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--r-pill)',
                  background: on ? 'rgba(255,255,255,0.25)' : 'var(--red)', color: '#fff',
                  font: '700 var(--fs-caption)/18px var(--font-text)', textAlign: 'center',
                }}>{badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* settings pinned */}
      <div style={{ padding: '6px 10px 12px', borderTop: '0.5px solid var(--separator)' }}>
        <button onClick={() => onNav && onNav('settings')} style={{
          display: 'flex', alignItems: 'center', gap: 11, width: '100%', height: 36, padding: '0 10px', borderRadius: 8,
          color: 'var(--ink-secondary)', font: '500 var(--fs-subhead)/1 var(--font-text)',
        }} className="nav-item">
          <Icon name="settings" size={18} /> Settings
        </button>
      </div>

      {/* drag-to-resize handle on the right edge */}
      <div onMouseDown={(e) => startSidebarDrag(e)} className="win-no-drag sb-resize" title="Drag to resize" style={{
        position: 'absolute', top: 0, right: -3, width: 7, height: '100%', cursor: 'col-resize', zIndex: 5,
      }} />
    </aside>
  );
}

/* Spend chip — no cap. Using a CLI subscription, there's nothing to cap; we
   only ever show what's been spent this month. Self-fetches the live figure and
   refreshes on job activity, so every screen shows the same real number. Clicking
   opens the Costs view. */
export function BudgetChip() {
  const navigate = useNavigate();
  const [month, setMonth] = React.useState<number | null>(null);
  React.useEffect(() => {
    let alive = true;
    const refresh = () => { api.costs().then(c => { if (alive) setMonth(c.thisMonth); }).catch(() => {}); };
    refresh();
    const unsub = api.subscribe({ onJob: refresh });
    return () => { alive = false; unsub(); };
  }, []);
  return (
    <button onClick={() => navigate('/budget')} title="Costs this month" style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 13px',
      borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)', cursor: 'pointer',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: 'var(--green)', flexShrink: 0 }} />
      <span style={{ font: '600 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink)' }}>
        {month === null ? '—' : <CountUp value={month} format={n => '$' + n.toFixed(2)} />}
      </span>
      <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>this month</span>
    </button>
  );
}

export interface ToolbarProps {
  onSearch?: () => void;
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  right?: React.ReactNode;
  /** When the sidebar is hidden, the toolbar shows a button to bring it back. */
  sidebarHidden?: boolean;
}

export function Toolbar({ onSearch, theme, setTheme, right, sidebarHidden }: ToolbarProps) {
  const navigate = useNavigate();
  const pending = usePendingApprovals();
  return (
    <header className="win-drag" style={{
      height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14,
      padding: sidebarHidden ? '0 16px 0 78px' : '0 16px 0 18px',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      borderBottom: '0.5px solid var(--separator)', position: 'relative', zIndex: 20,
      transition: 'padding-left 200ms cubic-bezier(.32,.72,0,1)',
    }}>
      {sidebarHidden && (
        <button onClick={() => setSidebarHidden(false)} title="Show sidebar (⌘B)" aria-label="Show sidebar" className="tb-icon win-no-drag" style={{
          width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0,
        }}>
          <Icon name="sidebar" size={19} />
        </button>
      )}

      {/* search */}
      <button onClick={onSearch} style={{
        flex: 1, maxWidth: 420, display: 'flex', alignItems: 'center', gap: 9, height: 34, padding: '0 12px',
        borderRadius: 9, background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', textAlign: 'left',
      }} className="search-field">
        <Icon name="search" size={16} style={{ color: 'var(--ink-tertiary)' }} />
        <span style={{ flex: 1, font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Search or press ⌘K</span>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 1, padding: '2px 6px', borderRadius: 5,
          background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)',
        }}>⌘K</span>
      </button>

      <div style={{ flex: 1 }} />

      {right}

      <BudgetChip />

      <button className="tb-icon" onClick={() => navigate('/approvals')} aria-label="Approvals" title={pending > 0 ? `${pending} waiting` : 'Approvals'} style={{
        width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', position: 'relative',
        color: 'var(--ink-secondary)',
      }}>
        <Icon name="bell" size={19} />
        {pending > 0 && <span style={{ position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: 4, background: 'var(--red)', border: '1.5px solid var(--bg-grouped)' }} />}
      </button>

      <button className="tb-icon" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label="Toggle appearance" style={{
        width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)',
      }}>
        <Icon name={theme === 'light' ? 'moon' : 'sun'} size={18} />
      </button>
    </header>
  );
}

export interface AppShellProps {
  /** Current nav key (highlights the matching sidebar item). */
  active?: string;
  children?: React.ReactNode;
  /** Toolbar props (all optional; theme is managed internally if omitted). */
  onSearch?: () => void;
  right?: React.ReactNode;
  /** Initial theme; the shell owns theme state and the appearance toggle. */
  initialTheme?: Theme;
  /** Called when the workspace header is clicked. */
  onWorkspace?: () => void;
}

/* Full desktop chrome: scaled macOS window + frosted sidebar + toolbar wrapper.
   Sidebar navigation is driven by the shared route registry (routes.ts) so the
   nav keys always resolve to real routes, and the active item is derived from
   the current location — this is the fix for the original dead-nav bug. */
export function AppShell({ active, children, onSearch, right, initialTheme = 'light', onWorkspace }: AppShellProps) {
  const scale = useAppScale();
  const [theme, setTheme] = useTheme(initialTheme);
  const navigate = useNavigate();
  const location = useLocation();
  const { hidden } = useSidebar();
  const routeKey = ALL_NAV.find(r => location.pathname === r.path || location.pathname.startsWith(r.path + '/'))?.key;
  const onNav = (key: string) => navigate(pathForNav(key));
  // ⌘B toggles the sidebar from anywhere in the chrome.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleSidebar(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <div style={{
        width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--bg)',
        display: 'flex',
      }}>
        <div className="app-wallpaper" aria-hidden="true" />
        <TrafficLights />
        {!hidden && <Sidebar active={active ?? routeKey} onNav={onNav} onWorkspace={onWorkspace} />}
        {hidden && <SidebarRevealZone />}
        <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
          <Toolbar onSearch={onSearch} theme={theme} setTheme={setTheme} right={right} sidebarHidden={hidden} />
          <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

/* When the sidebar is hidden, a thin invisible strip hugs the window's left
   edge. Click it (or the toolbar button) to bring the sidebar back; press-drag
   from it slides the sidebar out at whatever width you release at — exactly the
   "drag from the edge to reveal with resize" gesture. A faint handle pip fades
   in on hover so the affordance is discoverable. */
function SidebarRevealZone() {
  const [hot, setHot] = React.useState(false);
  return (
    <div
      className="win-no-drag"
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onMouseDown={(e) => startSidebarDrag(e, { reveal: true })}
      onClick={() => setSidebarHidden(false)}
      title="Show sidebar (⌘B) · drag to reveal"
      style={{ position: 'absolute', top: 0, left: 0, width: 14, height: '100%', cursor: 'col-resize', zIndex: 30 }}
    >
      <div style={{
        position: 'absolute', top: '50%', left: 4, transform: 'translateY(-50%)',
        width: 4, height: 46, borderRadius: 3, background: 'var(--ink-quaternary, var(--ink-tertiary))',
        opacity: hot ? 0.9 : 0, transition: 'opacity 160ms ease',
      }} />
    </div>
  );
}
