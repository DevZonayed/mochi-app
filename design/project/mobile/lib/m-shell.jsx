/* Maestro mobile — iPhone shell: frame, status bar, tab bar, sheets, atoms.
   Screen content lives inside <PhoneFrame>. 390×844 logical, scaled to fit. */

const MW = 390, MH = 844;

function useFit(pad = 40) {
  const [s, setS] = React.useState(1);
  React.useLayoutEffect(() => {
    const fit = () => setS(Math.min((window.innerWidth - pad) / MW, (window.innerHeight - pad) / MH, 1));
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, []);
  return s;
}
function useTheme(initial = 'light') {
  const [t, setT] = React.useState(initial);
  React.useEffect(() => { document.documentElement.dataset.theme = t; }, [t]);
  return [t, setT];
}
const mnav = (k) => {
  const map = { home: '../home/Home.html', jobs: '../jobs/Jobs.html', approvals: '../approvals/Approvals.html', studio: '../studio/Studio.html', settings: '../settings/Settings.html' };
  if (map[k]) location.href = map[k];
};

function StatusBar({ tint }) {
  const c = tint || 'var(--ink)';
  return (
    <div style={{ height: 54, flexShrink: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '0 28px 8px', position: 'relative', zIndex: 5 }}>
      <span style={{ font: '600 15px/1 var(--font-text)', color: c, letterSpacing: '0.02em' }}>9:41</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: c }}>
        {/* cellular */}
        <svg width="18" height="12" viewBox="0 0 18 12" fill={c}><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5" width="3" height="7" rx="1"/><rect x="10" y="2.5" width="3" height="9.5" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1" opacity="0.35"/></svg>
        {/* wifi */}
        <svg width="17" height="12" viewBox="0 0 17 12" fill={c}><path d="M8.5 2.2c2.6 0 5 1 6.8 2.7l-1.4 1.5A7.8 7.8 0 0 0 8.5 4.3 7.8 7.8 0 0 0 3.1 6.4L1.7 4.9A9.8 9.8 0 0 1 8.5 2.2Z"/><path d="M8.5 6c1.5 0 2.9.6 3.9 1.6l-1.5 1.5a3.4 3.4 0 0 0-4.8 0L4.6 7.6A5.4 5.4 0 0 1 8.5 6Z"/><circle cx="8.5" cy="10.4" r="1.4"/></svg>
        {/* battery */}
        <svg width="26" height="13" viewBox="0 0 26 13" fill="none"><rect x="0.5" y="0.5" width="22" height="12" rx="3.5" stroke={c} opacity="0.4"/><rect x="2" y="2" width="17" height="9" rx="2" fill={c}/><rect x="24" y="4" width="1.6" height="5" rx="0.8" fill={c} opacity="0.4"/></svg>
      </div>
    </div>
  );
}

function PhoneFrame({ children, tabBar, statusTint, bg, noScroll }) {
  const scale = useFit();
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: MW, height: MH, transform: `scale(${scale})`, transformOrigin: 'center', position: 'relative', flexShrink: 0,
        borderRadius: 56, padding: 4, background: '#000',
        boxShadow: '0 0 0 2px #2a2a2e, 0 50px 120px rgba(10,15,40,0.5)' }}>
        <div style={{ position: 'absolute', inset: 4, borderRadius: 52, overflow: 'hidden', background: bg || 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
          {/* dynamic island */}
          <div style={{ position: 'absolute', top: 11, left: '50%', transform: 'translateX(-50%)', width: 122, height: 34, borderRadius: 18, background: '#000', zIndex: 20 }} />
          <StatusBar tint={statusTint} />
          <div style={{ flex: 1, minHeight: 0, overflowY: noScroll ? 'hidden' : 'auto', position: 'relative' }} className="m-scroll">
            {children}
          </div>
          {tabBar}
          {/* home indicator */}
          <div style={{ height: 0, position: 'relative', zIndex: 30 }}>
            <span style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', width: 134, height: 5, borderRadius: 3, background: 'var(--ink)', opacity: 0.85 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { key: 'home', icon: 'home', label: 'Home' },
  { key: 'jobs', icon: 'jobs', label: 'Jobs' },
  { key: 'approvals', icon: 'shield', label: 'Approvals', badge: 2 },
  { key: 'studio', icon: 'clapper', label: 'Studio' },
  { key: 'settings', icon: 'settings', label: 'Settings' },
];
function TabBar({ active }) {
  return (
    <div style={{ flexShrink: 0, paddingBottom: 22, paddingTop: 8, display: 'flex', justifyContent: 'space-around',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)', borderTop: '0.5px solid var(--separator)' }}>
      {TABS.map(t => {
        const on = active === t.key;
        return (
          <button key={t.key} onClick={() => mnav(t.key)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '2px 6px', position: 'relative', width: 60 }}>
            <span style={{ position: 'relative', color: on ? 'var(--blue)' : 'var(--ink-tertiary)' }}>
              <Icon name={t.icon} size={25} stroke={on ? 2.4 : 1.9} />
              {t.badge && <span style={{ position: 'absolute', top: -3, right: -7, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: 'var(--red)', color: '#fff', font: '700 10px/16px var(--font-text)', textAlign: 'center' }}>{t.badge}</span>}
            </span>
            <span style={{ font: `${on ? 600 : 500} 10px/1 var(--font-text)`, color: on ? 'var(--blue)' : 'var(--ink-tertiary)' }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Large-title header that lives at top of a scroll body
function LargeTitle({ title, trailing, sub }) {
  return (
    <div style={{ padding: '6px 20px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ margin: 0, font: '700 34px/1.05 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{title}</h1>
        {trailing}
      </div>
      {sub && <p style={{ margin: '6px 0 0', font: '400 15px/1.35 var(--font-text)', color: 'var(--ink-secondary)' }}>{sub}</p>}
    </div>
  );
}

function MPill({ children, onClick, kind = 'primary', icon, style, disabled }) {
  const kinds = {
    primary: { background: disabled ? 'var(--fill-secondary)' : 'var(--blue)', color: disabled ? 'var(--ink-tertiary)' : '#fff', boxShadow: disabled ? 'none' : '0 6px 18px rgba(0,122,255,0.32)' },
    plain: { background: 'var(--fill-secondary)', color: 'var(--ink)' },
    green: { background: 'var(--green)', color: '#fff', boxShadow: '0 6px 18px rgba(52,199,89,0.3)' },
  };
  return (
    <button onClick={() => !disabled && onClick && onClick()} className="m-pill" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 50, padding: '0 22px', borderRadius: 'var(--r-pill)', font: '600 17px/1 var(--font-text)', ...kinds[kind], ...style }}>
      {icon && <Icon name={icon} size={18} />}{children}
    </button>
  );
}

// iOS grouped list
function MGroup({ header, footer, children, style }) {
  return (
    <div style={{ padding: '0 16px', ...style }}>
      {header && <div style={{ font: '400 13px/1.3 var(--font-text)', color: 'var(--ink-secondary)', padding: '0 14px 7px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{header}</div>}
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 12, overflow: 'hidden', border: '0.5px solid var(--separator)' }}>{children}</div>
      {footer && <div style={{ font: '400 13px/1.4 var(--font-text)', color: 'var(--ink-secondary)', padding: '7px 14px 0' }}>{footer}</div>}
    </div>
  );
}
function MRow({ children, last, onClick, style }) {
  return <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, padding: '10px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', cursor: onClick ? 'pointer' : 'default', ...style }}>{children}</div>;
}

// bottom sheet
function MSheet({ open, onClose, children, detent = 0.62, label }) {
  if (!open) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 60, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(10,12,24,0.4)', animation: 'mFade 200ms ease' }} />
      <div className="m-sheet" style={{ position: 'relative', maxHeight: `${detent * 100}%`, background: 'var(--bg)', borderRadius: '16px 16px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 -10px 40px rgba(10,15,40,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, flexShrink: 0 }}><span style={{ width: 36, height: 5, borderRadius: 3, background: 'var(--separator-strong)' }} /></div>
        <div style={{ overflowY: 'auto', padding: '8px 0 28px' }}>{children}</div>
      </div>
    </div>
  );
}

// project dot + name chip
const M_PROJ = {
  atlas: { name: 'Atlas API', color: 'var(--blue)' }, content: { name: 'Q3 Content', color: 'var(--purple)' },
  scan: { name: 'Market Scan', color: 'var(--indigo)' }, brand: { name: 'Brand Refresh', color: 'var(--teal)' }, infra: { name: 'Infra / CI', color: 'var(--orange)' },
};

Object.assign(window, { MW, MH, useFit, useTheme, mnav, StatusBar, PhoneFrame, TabBar, LargeTitle, MPill, MGroup, MRow, MSheet, M_PROJ });
