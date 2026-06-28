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

/** A monospace code chip you click to copy (e.g. the GitHub device-flow code).
    Flashes a green check + "Copied" for ~1.5s on success. */
export function CopyCode({ code, title = 'Click to copy' }: { code: string; title?: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    const done = () => { setCopied(true); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setCopied(false), 1500); };
    try {
      if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(code).then(done).catch(() => {}); return; }
    } catch { /* fall through to execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = code; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      done();
    } catch { /* clipboard unavailable */ }
  };
  return (
    <button onClick={copy} title={copied ? 'Copied!' : title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 9px', borderRadius: 7, cursor: 'pointer',
      border: `1px solid ${copied ? 'color-mix(in srgb, var(--green) 45%, transparent)' : 'var(--separator-strong)'}`,
      background: copied ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'var(--fill-tertiary)',
      color: 'var(--ink)', font: '700 13px/1 var(--font-mono)', letterSpacing: '0.08em', transition: 'background 120ms ease, border-color 120ms ease',
    }}>
      {code}
      <Icon name="check" size={12} stroke={2.6} style={{ color: copied ? 'var(--green)' : 'var(--ink-tertiary)', opacity: copied ? 1 : 0.55 }} />
    </button>
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
  const h = compact ? 28 : 34;
  const cycle = () => { const i = EFFORT_STOPS.indexOf(value); onChange!(EFFORT_STOPS[(i + 1) % 4]); };
  return (
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

/* The real engines Maestro runs on this Mac. 'auto' follows the routing set in
   Settings → Engines; the other two force a per-job engine override. Both run on
   your own sign-ins (Claude Code subscription / Codex ChatGPT), so cost is 0 here. */
export const DEFAULT_MODELS: ModelOption[] = [
  { id: 'auto',   name: 'Auto',        provider: 'auto',      sub: 'Use routing default', cost: 0 },
  { id: 'claude', name: 'Claude Code', provider: 'anthropic', sub: 'Your Claude login',   cost: 0 },
  { id: 'codex',  name: 'Codex',       provider: 'openai',    sub: 'Your ChatGPT login',  cost: 0 },
];

/* One flat picker = engine AND model in a single click (no nested menus).
   Kept for older surfaces; active chat/settings model variants come from the
   provider-backed ModelPicker. */
export const CHAT_MODELS: ModelOption[] = [
  { id: 'auto',                         name: 'Auto',                 provider: 'auto',      sub: 'Routing default',        cost: 0 },
  { id: 'claude:claude-opus-4-8',       name: 'Claude · Opus 4.8',    provider: 'anthropic', sub: 'Most capable',           cost: 0 },
  { id: 'claude:claude-sonnet-4-6',     name: 'Claude · Sonnet 4.6',  provider: 'anthropic', sub: 'Balanced speed & depth', cost: 0 },
  { id: 'claude:claude-haiku-4-5-20251001', name: 'Claude · Haiku 4.5', provider: 'anthropic', sub: 'Fastest replies',        cost: 0 },
  { id: 'codex',                        name: 'Codex',                provider: 'openai',    sub: 'Your codex default',     cost: 0 },
];

/** Map a CHAT_MODELS id → the engine/model pair the dispatcher understands. */
export function chatModelToRun(id: string): { engine?: 'claude' | 'codex'; model?: string } {
  if (id === 'codex') return { engine: 'codex' };
  if (id.startsWith('claude:')) return { engine: 'claude', model: id.slice('claude:'.length) };
  return {};
}

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
  /** 'up' opens the menu above the button (for pickers docked at the bottom). */
  direction?: 'down' | 'up';
}

export function ModelSwitcher({ value = 'auto', onChange, models, compact, align = 'left', direction = 'down' }: ModelSwitcherProps) {
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
          position: 'absolute', ...(direction === 'up' ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }), [align]: 0, zIndex: 50, width: 232,
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

/* Smoothly animated number. Tweens from the value it is CURRENTLY showing to
   the new target (never restarts from 0), so live counters — tokens, cost,
   spend — roll up smoothly instead of snapping. `format` controls how the
   interpolated value is rendered (default: rounded with thousands separators).
   Honors prefers-reduced-motion. */
export interface CountUpProps {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function CountUp({ value, format, duration = 650, className, style }: CountUpProps) {
  const [shown, setShown] = React.useState(value);
  const shownRef = React.useRef(value);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const from = shownRef.current;
    const to = value;
    if (Math.abs(to - from) < 1e-6) { shownRef.current = to; setShown(to); return; }
    const reduce = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { shownRef.current = to; setShown(to); return; }
    let start: number | null = null;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic — fast then settles
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      const cur = from + (to - from) * ease(p);
      shownRef.current = cur;
      setShown(cur);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else { shownRef.current = to; setShown(to); rafRef.current = null; }
    };
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [value, duration]);

  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString());
  return <span className={className} style={style}>{fmt(shown)}</span>;
}
