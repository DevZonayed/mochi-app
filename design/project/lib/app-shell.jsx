/* Shared Maestro desktop app chrome: scaled macOS window, frosted sidebar,
   frosted toolbar with traffic lights + budget chip. Used by every app page. */

const APP_W = 1320, APP_H = 860;

function useAppScale(pad = 40) {
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    const fit = () => setScale(Math.min((window.innerWidth - pad) / APP_W, (window.innerHeight - pad) / APP_H, 1));
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, []);
  return scale;
}

function useTheme(initial = 'light') {
  const [theme, setTheme] = React.useState(initial);
  React.useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return [theme, setTheme];
}

const WORKSPACE = 'Atlas Studio';

const NAV = [
  { key: 'home', icon: 'home', label: 'Home' },
  { key: 'projects', icon: 'layers', label: 'Projects' },
  { key: 'jobs', icon: 'jobs', label: 'Jobs' },
  { key: 'approvals', icon: 'shield', label: 'Approvals', badge: 3 },
  { key: 'scheduler', icon: 'calendar', label: 'Scheduler' },
  { key: 'skills', icon: 'spark', label: 'Skills' },
  { key: 'templates', icon: 'sliders', label: 'Templates' },
  { key: 'trends', icon: 'telescope', label: 'Trends' },
  { key: 'studio', icon: 'clapper', label: 'Studio' },
  { key: 'publishing', icon: 'send', label: 'Publishing' },
  { key: 'budget', icon: 'gauge', label: 'Budget' },
];

// shared cross-page nav routing (relative to a page one folder deep)
function navTo(k) {
  const map = {
    home: '../command-center/Command Center.html',
    projects: '../projects/Projects.html',
    templates: '../templates/Project Templates.html',
    trends: '../trends/Trend Intelligence.html',
    studio: '../media-studio/Media Studio.html',
    publishing: '../publishing/Publishing Center.html',
  };
  if (map[k]) location.href = map[k];
}

function TrafficLights() {
  return (
    <div style={{ display: 'flex', gap: 8, position: 'absolute', top: 19, left: 20, zIndex: 50 }}>
      {['#ff5f57', '#febc2e', '#28c840'].map(c => (
        <span key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c, border: '0.5px solid rgba(0,0,0,0.13)' }} />
      ))}
    </div>
  );
}

function Sidebar({ active, onNav, onWorkspace }) {
  return (
    <aside style={{
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
        {NAV.map(n => {
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

function BudgetChip({ spent, cap, animateKey }) {
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

function Toolbar({ onSearch, budget, theme, setTheme, right }) {
  return (
    <header style={{
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

function WindowFrame({ children }) {
  const scale = useAppScale();
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <div style={{
        width: APP_W, height: APP_H, transform: `scale(${scale})`, transformOrigin: 'center',
        borderRadius: 16, overflow: 'hidden', position: 'relative', background: 'var(--bg)',
        boxShadow: '0 0 0 0.5px rgba(0,0,0,0.16), 0 44px 110px rgba(10,15,40,0.42)',
        display: 'flex',
      }}>
        <div className="app-wallpaper" aria-hidden="true" />
        <TrafficLights />
        {children}
      </div>
    </div>
  );
}

Object.assign(window, { APP_W, APP_H, useAppScale, useTheme, WORKSPACE, NAV, navTo, TrafficLights, Sidebar, Toolbar, BudgetChip, WindowFrame });
