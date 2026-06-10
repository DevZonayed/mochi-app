/* Shared Maestro UI primitives: pill buttons, grouped-inset lists,
   iOS switch, status pill, spinner, segmented control.
   Ported to ES-module TypeScript React — visual output unchanged. */

import React from 'react';
import { Icon, AnthropicGlyph, OpenAIGlyph, type IconName } from './icons';

export type PillButtonKind = 'primary' | 'quiet' | 'plain';

export interface PillButtonProps {
  children?: React.ReactNode;
  onClick?: () => void;
  kind?: PillButtonKind;
  disabled?: boolean;
  icon?: IconName;
  style?: React.CSSProperties;
}

export function PillButton({ children, onClick, kind = 'primary', disabled, icon, style }: PillButtonProps) {
  const [press, setPress] = React.useState(false);
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    height: 44, padding: '0 22px', borderRadius: 'var(--r-pill)',
    fontFamily: 'var(--font-text)', fontSize: 16, fontWeight: 600,
    letterSpacing: '-0.01em', transition: 'transform 120ms var(--spring), background 160ms ease, opacity 160ms ease',
    transform: press ? 'translateY(1px) scale(0.985)' : 'none',
    userSelect: 'none', whiteSpace: 'nowrap', ...style,
  };
  const kinds: Record<PillButtonKind, React.CSSProperties> = {
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

export interface GroupedListProps {
  children?: React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export function GroupedList({ children, header, footer }: GroupedListProps) {
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

export interface RowProps {
  children?: React.ReactNode;
  last?: boolean;
  style?: React.CSSProperties;
  onClick?: () => void;
}

export function Row({ children, last, style, onClick }: RowProps) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, minHeight: 56,
      padding: '10px 14px',
      borderBottom: last ? 'none' : '0.5px solid var(--separator)',
      cursor: onClick ? 'pointer' : 'default', ...style,
    }}>{children}</div>
  );
}

export type StatusPillState = 'idle' | 'waiting' | 'connected' | 'error';

export function StatusPill({ state }: { state: StatusPillState }) {
  const map: Record<StatusPillState, { label: string; bg: string; fg: string; dot: string }> = {
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

export interface SpinnerProps {
  size?: number;
  color?: string;
}

export function Spinner({ size = 16, color = 'currentColor' }: SpinnerProps) {
  return (
    <span style={{
      width: size, height: size, display: 'inline-block', borderRadius: '50%',
      border: `${Math.max(1.5, size / 9)}px solid color-mix(in srgb, ${color} 28%, transparent)`,
      borderTopColor: color, animation: 'spin 0.7s linear infinite',
    }} />
  );
}

export interface SwitchProps {
  on: boolean;
  onChange: (next: boolean) => void;
}

export function Switch({ on, onChange }: SwitchProps) {
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

// ── Effort: a single button that cycles FAST → BALANCED → DEEP → MAX,
//    with a signal-bar "strength" symbol (1–4 bars, color-coded).
export type EffortStop = 'FAST' | 'BALANCED' | 'DEEP' | 'MAX';

export const EFFORT_STOPS: EffortStop[] = ['FAST', 'BALANCED', 'DEEP', 'MAX'];

export const EFFORT_META: Record<EffortStop, { tint: string; bars: number }> = {
  FAST:     { tint: 'var(--green)',  bars: 1 },
  BALANCED: { tint: 'var(--blue)',   bars: 2 },
  DEEP:     { tint: 'var(--orange)', bars: 3 },
  MAX:      { tint: 'var(--red)',    bars: 4 },
};

export interface StrengthBarsProps {
  level?: number;
  tint?: string;
  size?: number;
}

// 4 ascending bars; filled up to `level` in `tint`, rest faded.
export function StrengthBars({ level = 2, tint = 'var(--blue)', size = 15 }: StrengthBarsProps) {
  const heights = [0.42, 0.62, 0.82, 1];
  const bw = size * 0.17, gap = size * 0.115;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      {heights.map((h, idx) => {
        const x = idx * (bw + gap) + bw * 0.3, barH = size * h, on = idx < level;
        return <rect key={idx} x={x} y={size - barH} width={bw} height={barH} rx={bw * 0.4}
          fill={on ? tint : 'var(--ink-tertiary)'} opacity={on ? 1 : 0.3} style={{ transition: 'fill 200ms ease, opacity 200ms ease' }} />;
      })}
    </svg>
  );
}

export interface EffortDialProps {
  value?: EffortStop;
  compact?: boolean;
  onChange?: (next: EffortStop) => void;
}

// Pass onChange to make it cycle on click; omit for a read-only display.
export function EffortDial({ value = 'BALANCED', compact, onChange }: EffortDialProps) {
  const interactive = typeof onChange === 'function';
  const meta = EFFORT_META[value] || EFFORT_META.BALANCED;
  const showCost = value === 'DEEP' || value === 'MAX';
  const h = compact ? 28 : 34;
  const cycle = () => { const i = EFFORT_STOPS.indexOf(value); onChange!(EFFORT_STOPS[(i + 1) % 4]); };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button onClick={() => interactive && cycle()} disabled={!interactive}
        title={interactive ? 'Click to change effort' : undefined} aria-label={`Effort: ${value}`}
        className="effort-btn" style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, height: h, padding: compact ? '0 11px' : '0 13px',
          borderRadius: 'var(--r-pill)', background: `color-mix(in srgb, ${meta.tint} 11%, transparent)`,
          border: `1px solid color-mix(in srgb, ${meta.tint} 32%, transparent)`,
          cursor: interactive ? 'pointer' : 'default', transition: 'background 160ms ease, border-color 160ms ease, transform 100ms var(--spring)',
        }}>
        <StrengthBars level={meta.bars} tint={meta.tint} size={compact ? 13 : 15} />
        <span style={{ font: '700 11px/1 var(--font-text)', letterSpacing: '0.05em', color: meta.tint }}>{value}</span>
        {interactive && <span aria-hidden="true" style={{ display: 'inline-flex', gap: 2, marginLeft: 1 }}>
          {[0, 1, 2, 3].map(d => <span key={d} style={{ width: 3, height: 3, borderRadius: 2, background: d === EFFORT_STOPS.indexOf(value) ? meta.tint : 'var(--ink-tertiary)', opacity: d === EFFORT_STOPS.indexOf(value) ? 1 : 0.35 }} />)}
        </span>}
      </button>
      {showCost && (
        <span className="cost-chip" style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px',
          borderRadius: 'var(--r-pill)', background: 'rgba(255,149,0,0.15)', color: 'var(--orange)',
          font: '600 var(--fs-footnote)/1 var(--font-mono)', whiteSpace: 'nowrap',
        }}>≈ {value === 'MAX' ? '5×' : '3×'} cost · {value === 'MAX' ? '12×' : '6×'} latency</span>
      )}
    </div>
  );
}

// ── Model switcher — deliberately different from Effort: a pill that opens
//    a pick-from-list popover (provider glyph + tier + relative cost dots).
export type ModelProvider = 'auto' | 'anthropic' | 'openai';

export interface ModelOption {
  id: string;
  name: string;
  provider: ModelProvider;
  sub: string;
  cost: number;
}

export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'auto',   name: 'Auto',   provider: 'auto',      sub: 'Routed per task', cost: 0 },
  { id: 'opus',   name: 'Opus',   provider: 'anthropic', sub: 'Most capable',    cost: 3 },
  { id: 'sonnet', name: 'Sonnet', provider: 'anthropic', sub: 'Balanced',        cost: 2 },
  { id: 'haiku',  name: 'Haiku',  provider: 'anthropic', sub: 'Fastest',         cost: 1 },
  { id: 'gpt',    name: 'GPT-4o', provider: 'openai',    sub: 'Media & vision',  cost: 2 },
];

export function ProviderGlyph({ provider, size = 18 }: { provider: ModelProvider; size?: number }) {
  if (provider === 'anthropic') return <AnthropicGlyph size={size} />;
  if (provider === 'openai') return <OpenAIGlyph size={size} />;
  return <Icon name="cpu" size={size} />;
}

export function CostDots({ n }: { n: number }) {
  if (!n) return <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--green)' }}>auto</span>;
  return <span style={{ display: 'inline-flex', gap: 2 }}>{[1, 2, 3].map(d => <span key={d} style={{ width: 5, height: 5, borderRadius: 3, background: d <= n ? 'var(--orange)' : 'var(--ink-tertiary)', opacity: d <= n ? 1 : 0.3 }} />)}</span>;
}

export interface ModelSwitcherProps {
  value?: string;
  onChange?: (id: string) => void;
  models?: ModelOption[];
  compact?: boolean;
  align?: 'left' | 'right';
}

export function ModelSwitcher({ value = 'auto', onChange, models, compact, align = 'left' }: ModelSwitcherProps) {
  const list = models || DEFAULT_MODELS;
  const cur = list.find(m => m.id === value) || list[0];
  const interactive = typeof onChange === 'function';
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const h = compact ? 28 : 34;
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button onClick={() => interactive && setOpen(o => !o)} disabled={!interactive}
        className="model-btn" style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, height: h, padding: compact ? '0 10px' : '0 12px',
          borderRadius: 9, background: 'var(--fill-secondary)', color: 'var(--ink)',
          cursor: interactive ? 'pointer' : 'default', transition: 'background 140ms ease',
        }}>
        <span style={{ color: cur.provider === 'auto' ? 'var(--ink-secondary)' : 'var(--ink)', display: 'inline-flex' }}><ProviderGlyph provider={cur.provider} size={compact ? 15 : 17} /></span>
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>{cur.name}</span>
        {interactive && <Icon name="chevronDown" size={13} style={{ color: 'var(--ink-tertiary)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms var(--spring)' }} />}
      </button>
      {open && (
        <div className="model-pop" style={{
          position: 'absolute', top: `calc(100% + 6px)`, [align]: 0, zIndex: 50, width: 232,
          background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)',
          boxShadow: 'var(--shadow-lg, 0 18px 50px rgba(15,20,60,0.22))', overflow: 'hidden', padding: 4,
        }}>
          {list.map(m => {
            const on = m.id === value;
            return (
              <button key={m.id} onClick={() => { onChange!(m.id); setOpen(false); }} style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 8, textAlign: 'left',
                background: on ? 'color-mix(in srgb, var(--blue) 10%, transparent)' : 'transparent',
              }} className="model-opt">
                <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--fill-tertiary)', color: m.provider === 'auto' ? 'var(--ink-secondary)' : 'var(--ink)' }}><ProviderGlyph provider={m.provider} size={17} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', font: '600 var(--fs-subhead)/1.1 var(--font-text)', color: 'var(--ink)' }}>{m.name}</span>
                  <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{m.sub}</span>
                </span>
                {on ? <Icon name="check" size={16} stroke={2.6} style={{ color: 'var(--blue)', flexShrink: 0 }} /> : <CostDots n={m.cost} />}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

// effort → pre-run estimate
export const EFFORT_EST: Record<EffortStop, { cost: string; mins: string }> = {
  FAST:     { cost: '0.30', mins: '3' },
  BALANCED: { cost: '0.60', mins: '6' },
  DEEP:     { cost: '1.80', mins: '36' },
  MAX:      { cost: '3.00', mins: '72' },
};
