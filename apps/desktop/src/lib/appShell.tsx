/* Shared Maestro desktop app chrome: scaled macOS window, frosted sidebar,
   frosted toolbar with traffic lights + budget chip. Used by every app page.
   Ported to ES-module TypeScript React with react-router navigation —
   visual output unchanged. */

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon, MaestroMark } from './icons';
import { NAV_ROUTES, ALL_NAV } from './routes';

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

export const WORKSPACE = 'Atlas Studio';

export function TrafficLights() {
  // The native macOS window supplies the real traffic lights (titleBarStyle:
  // hiddenInset). The app now fills the window, so no fake chrome is drawn.
  return null;
}

export interface SidebarProps {
  active?: string;
  onNav?: (key: string) => void;
  onWorkspace?: () => void;
}

export function Sidebar({ active, onNav, onWorkspace }: SidebarProps) {
  return (
    <aside className="win-drag" style={{
      width: 260, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 2,
      background: 'var(--bg-grouped)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      borderRight: '0.5px solid var(--separator)',
    }}>
      {/* workspace header */}
      <button onClick={onWorkspace} style={{
        display: 'flex', alignItems: 'center', gap: 10, margin: '46px 10px 10px', padding: '8px 10px',
        borderRadius: 10, textAlign: 'left',
      }} className="ws-header">
        <MaestroMark size={30} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', font: '700 var(--fs-callout)/1.1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>{WORKSPACE}</span>
          <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 1 }}>Workspace</span>
        </span>
        <Icon name="chevronDown" size={15} style={{ color: 'var(--ink-tertiary)' }} />
      </button>

      {/* nav */}
      <nav style={{ flex: 1, overflow: 'auto', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {NAV_ROUTES.map(n => {
          const on = active === n.key;
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
              {n.badge && (
                <span style={{
                  minWidth: 18, height: 18, padding: '0 5px', borderRadius: 'var(--r-pill)',
                  background: on ? 'rgba(255,255,255,0.25)' : 'var(--red)', color: '#fff',
                  font: '700 var(--fs-caption)/18px var(--font-text)', textAlign: 'center',
                }}>{n.badge}</span>
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
    </aside>
  );
}

export interface BudgetChipProps {
  spent: number;
  cap: number;
  animateKey?: React.Key;
}

export function BudgetChip({ spent, cap, animateKey }: BudgetChipProps) {
  const pct = spent / cap;
  const tone = pct >= 0.9 ? 'var(--red)' : pct >= 0.75 ? 'var(--orange)' : 'var(--ink)';
  const bg = pct >= 0.9 ? 'rgba(255,59,48,0.12)' : pct >= 0.75 ? 'rgba(255,149,0,0.12)' : 'var(--fill-secondary)';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 12px',
      borderRadius: 'var(--r-pill)', background: bg, border: '0.5px solid var(--separator)',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: tone === 'var(--ink)' ? 'var(--green)' : tone, flexShrink: 0 }} />
      <span key={animateKey} className="count-up" style={{ font: '600 var(--fs-subhead)/1 var(--font-mono)', color: tone }}>
        ${spent.toFixed(2)}
      </span>
      <span style={{ font: '500 var(--fs-subhead)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>/ ${cap}</span>
    </div>
  );
}

export interface ToolbarProps {
  onSearch?: () => void;
  budget?: BudgetChipProps;
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  right?: React.ReactNode;
}

export function Toolbar({ onSearch, budget, theme, setTheme, right }: ToolbarProps) {
  return (
    <header className="win-drag" style={{
      height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 16px 0 18px',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(40px) saturate(180%)', WebkitBackdropFilter: 'blur(40px) saturate(180%)',
      borderBottom: '0.5px solid var(--separator)', position: 'relative', zIndex: 20,
    }}>
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

      {budget && <BudgetChip {...budget} />}

      <button className="tb-icon" aria-label="Notifications" style={{
        width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', position: 'relative',
        color: 'var(--ink-secondary)',
      }}>
        <Icon name="bell" size={19} />
        <span style={{ position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: 4, background: 'var(--red)', border: '1.5px solid var(--bg-grouped)' }} />
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
  budget?: BudgetChipProps;
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
export function AppShell({ active, children, onSearch, budget, right, initialTheme = 'light', onWorkspace }: AppShellProps) {
  const scale = useAppScale();
  const [theme, setTheme] = useTheme(initialTheme);
  const navigate = useNavigate();
  const location = useLocation();
  const routeKey = ALL_NAV.find(r => location.pathname === r.path || location.pathname.startsWith(r.path + '/'))?.key;
  const onNav = (key: string) => {
    const r = ALL_NAV.find(x => x.key === key);
    navigate(r ? r.path : '/' + key);
  };
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <div style={{
        width: '100%', height: '100%', overflow: 'hidden', position: 'relative', background: 'var(--bg)',
        display: 'flex',
      }}>
        <div className="app-wallpaper" aria-hidden="true" />
        <TrafficLights />
        <Sidebar active={active ?? routeKey} onNav={onNav} onWorkspace={onWorkspace} />
        <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 1 }}>
          <Toolbar onSearch={onSearch} budget={budget} theme={theme} setTheme={setTheme} right={right} />
          <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
