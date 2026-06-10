/* Shared Maestro UI primitives: pill buttons, grouped-inset lists,
   iOS switch, status pill, spinner, segmented control. */

function PillButton({ children, onClick, kind = 'primary', disabled, icon, style }) {
  const [press, setPress] = React.useState(false);
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    height: 44, padding: '0 22px', borderRadius: 'var(--r-pill)',
    fontFamily: 'var(--font-text)', fontSize: 16, fontWeight: 600,
    letterSpacing: '-0.01em', transition: 'transform 120ms var(--spring), background 160ms ease, opacity 160ms ease',
    transform: press ? 'translateY(1px) scale(0.985)' : 'none',
    userSelect: 'none', whiteSpace: 'nowrap', ...style,
  };
  const kinds = {
    primary: { background: disabled ? 'var(--fill-secondary)' : 'var(--blue)',
      color: disabled ? 'var(--ink-tertiary)' : '#fff',
      boxShadow: disabled ? 'none' : '0 6px 18px rgba(0,122,255,0.32)',
      cursor: disabled ? 'default' : 'pointer' },
    quiet: { background: 'transparent', color: 'var(--blue)', height: 40, padding: '0 12px',
      boxShadow: 'none' },
    plain: { background: 'var(--fill-secondary)', color: 'var(--ink)', boxShadow: 'none' },
  };
  return (
    <button
      onMouseDown={() => !disabled && setPress(true)}
      onMouseUp={() => setPress(false)}
      onMouseLeave={() => setPress(false)}
      onClick={() => !disabled && onClick && onClick()}
      style={{ ...base, ...kinds[kind] }}>
      {children}
      {icon && <Icon name={icon} size={18} />}
    </button>
  );
}

function GroupedList({ children, header, footer }) {
  return (
    <div style={{ width: '100%' }}>
      {header && <div style={{
        font: '600 var(--fs-caption)/1.3 var(--font-text)', letterSpacing: '0.04em',
        textTransform: 'uppercase', color: 'var(--ink-tertiary)',
        padding: '0 14px 7px', }}>{header}</div>}
      <div style={{
        background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)',
        border: '0.5px solid var(--separator)', overflow: 'hidden',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      }}>{children}</div>
      {footer && <div style={{
        font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)',
        padding: '8px 14px 0', }}>{footer}</div>}
    </div>
  );
}

function Row({ children, last, style, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, minHeight: 56,
      padding: '10px 14px',
      borderBottom: last ? 'none' : '0.5px solid var(--separator)',
      cursor: onClick ? 'pointer' : 'default', ...style,
    }}>{children}</div>
  );
}

function StatusPill({ state }) {
  const map = {
    idle: { label: 'Not connected', bg: 'var(--fill-secondary)', fg: 'var(--ink-secondary)', dot: 'var(--ink-tertiary)' },
    waiting: { label: 'Waiting for browser…', bg: 'rgba(255,149,0,0.14)', fg: 'var(--orange)', dot: 'var(--orange)' },
    connected: { label: 'Connected', bg: 'rgba(52,199,89,0.16)', fg: 'var(--green)', dot: 'var(--green)' },
    error: { label: 'Connection failed', bg: 'rgba(255,59,48,0.14)', fg: 'var(--red)', dot: 'var(--red)' },
  };
  const s = map[state];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)',
      background: s.bg, color: s.fg,
      font: '600 var(--fs-footnote)/1 var(--font-text)', whiteSpace: 'nowrap',
    }}>
      {state === 'connected'
        ? <Icon name="check" size={13} stroke={2.6} />
        : state === 'waiting'
          ? <Spinner size={12} />
          : <span style={{ width: 6, height: 6, borderRadius: 3, background: s.dot }} />}
      {s.label}
    </span>
  );
}

function Spinner({ size = 16, color = 'currentColor' }) {
  return (
    <span style={{
      width: size, height: size, display: 'inline-block', borderRadius: '50%',
      border: `${Math.max(1.5, size/9)}px solid color-mix(in srgb, ${color} 28%, transparent)`,
      borderTopColor: color, animation: 'spin 0.7s linear infinite',
    }} />
  );
}

function Switch({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      width: 51, height: 31, borderRadius: 'var(--r-pill)', position: 'relative',
      background: on ? 'var(--green)' : 'var(--fill-secondary)',
      transition: 'background 220ms var(--spring)', flexShrink: 0,
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 22 : 2, width: 27, height: 27,
        borderRadius: '50%', background: '#fff',
        boxShadow: '0 2px 5px rgba(0,0,0,0.25)', transition: 'left 260ms var(--spring)',
      }} />
    </button>
  );
}

// 4-stop signature Effort Dial (used as a nod on the dashboard)
function EffortDial({ value = 'BALANCED', compact }) {
  const stops = ['FAST', 'BALANCED', 'DEEP', 'MAX'];
  const i = stops.indexOf(value);
  const showCost = value === 'DEEP' || value === 'MAX';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        position: 'relative', display: 'inline-flex', padding: 2,
        background: 'var(--fill-secondary)', borderRadius: 9,
      }}>
        <div style={{
          position: 'absolute', top: 2, bottom: 2, left: `calc(${i*25}% + 2px)`,
          width: `calc(25% - 4px)`, background: 'var(--bg-elevated)', borderRadius: 7,
          boxShadow: '0 1px 3px rgba(0,0,0,0.14)', transition: 'left 280ms var(--spring)',
        }} />
        {stops.map(s => (
          <span key={s} style={{
            position: 'relative', zIndex: 1, padding: compact ? '5px 9px' : '6px 13px',
            font: '700 11px/1 var(--font-text)', letterSpacing: '0.04em',
            color: s === value ? 'var(--ink)' : 'var(--ink-secondary)',
          }}>{s}</span>
        ))}
      </div>
      {showCost && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px',
          borderRadius: 'var(--r-pill)', background: 'rgba(255,149,0,0.15)', color: 'var(--orange)',
          font: '600 var(--fs-footnote)/1 var(--font-mono)', whiteSpace: 'nowrap',
        }}>≈ {value === 'MAX' ? '5×' : '3×'} cost · {value === 'MAX' ? '12×' : '6×'} latency</span>
      )}
    </div>
  );
}

Object.assign(window, { PillButton, GroupedList, Row, StatusPill, Spinner, Switch, EffortDial });
