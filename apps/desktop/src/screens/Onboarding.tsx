/* Maestro onboarding — first-run setup assistant.
   Ported from the Babel-standalone prototype (design/project/onboarding/*.jsx)
   to an ES-module TypeScript React screen. Visual output is unchanged: a
   floating macOS setup-assistant window with an animated muted blue/purple
   backdrop and a centered frosted glass card, a five-step stepper, and a
   dashboard "peek" that resolves behind the dissolving card on finish.

   This is a full-window experience (no AppShell sidebar): it renders its own
   chrome exactly as the prototype did. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import {
  Icon,
  MaestroMark,
  AnthropicGlyph,
  OpenAIGlyph,
  type IconName,
} from '../lib/icons';
import {
  PillButton,
  GroupedList,
  Row,
  StatusPill,
  EffortDial,
} from '../lib/ui';

const WIN_W = 1240;
const WIN_H = 800;

// Page-specific CSS from Onboarding.html <style>. Rendered as a <style> child
// so the hover/animation class hooks still work.
const styles = `
  @keyframes spin { to { transform: rotate(360deg); } }

  /* animated muted blue/purple backdrop */
  .backdrop { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
  .blob {
    position: absolute; border-radius: 50%; filter: blur(48px);
    mix-blend-mode: screen; opacity: 0.85;
  }
  [data-theme="light"] .blob { mix-blend-mode: normal; opacity: 0.7; }
  .b1 { width: 760px; height: 760px; top: -200px; left: -140px;
        background: radial-gradient(circle at 50% 50%, var(--blob-a), transparent 62%);
        animation: drift1 24s ease-in-out infinite; }
  .b2 { width: 720px; height: 720px; bottom: -240px; right: -160px;
        background: radial-gradient(circle at 50% 50%, var(--blob-b), transparent 62%);
        animation: drift2 29s ease-in-out infinite; }
  .b3 { width: 560px; height: 560px; top: 26%; left: 38%; opacity: 0.5;
        background: radial-gradient(circle at 50% 50%, var(--blob-c), transparent 60%);
        animation: drift3 34s ease-in-out infinite; }
  .grain { position: absolute; inset: 0;
    background: radial-gradient(120% 90% at 50% 0%, transparent 55%, rgba(10,15,40,0.22) 100%); }
  [data-theme="light"] .grain { background: radial-gradient(120% 90% at 50% 0%, transparent 60%, rgba(120,130,170,0.18) 100%); }
  @keyframes drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(80px,60px) scale(1.08); } }
  @keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-70px,-50px) scale(1.1); } }
  @keyframes drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-60px,70px) scale(0.92); } }

  /* frosted glass card */
  .glass-card {
    width: 560px; padding: 38px 40px 32px; border-radius: var(--r-card);
    background: var(--glass-tint);
    backdrop-filter: blur(34px) saturate(180%); -webkit-backdrop-filter: blur(34px) saturate(180%);
    border: 0.5px solid var(--glass-border);
    box-shadow: var(--card-shadow), var(--glass-inner);
  }

  .card-body { min-height: 296px; }
  [data-dir="fwd"].card-body { animation: stepInFwd 320ms var(--spring); }
  [data-dir="back"].card-body { animation: stepInBack 320ms var(--spring); }
  @keyframes stepInFwd { from { transform: translateX(22px); } to { transform: none; } }
  @keyframes stepInBack { from { transform: translateX(-22px); } to { transform: none; } }

  /* dashboard behind finish — sharp at rest; blur→sharp only while finishing */
  .dash-wrap { position: absolute; inset: 0; z-index: 10; }
  .dash-wrap[data-phase="finishing"] { animation: dashReveal 1200ms var(--spring) both; }
  @keyframes dashReveal { from { filter: blur(26px) saturate(0.92); transform: scale(1.04); } to { filter: none; transform: none; } }

  .youre-set {
    position: absolute; inset: 0; z-index: 25; display: grid; place-items: center;
    text-align: center; background: var(--glass-tint);
    backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%);
    animation: youreSet 1500ms ease forwards;
  }
  .youre-set > * { animation: setRise 600ms var(--spring); }
  @keyframes youreSet { 0% { opacity: 0; } 16% { opacity: 1; } 72% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes setRise { from { opacity: 0; transform: translateY(10px) scale(0.96); } to { opacity: 1; transform: none; } }

  /* iOS slider */
  input[type="range"].ios-slider { -webkit-appearance: none; appearance: none; outline: none; }
  input[type="range"].ios-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 28px; height: 28px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(0,0,0,0.05); cursor: pointer;
  }
  input[type="range"].ios-slider::-moz-range-thumb {
    width: 28px; height: 28px; border: none; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.28); cursor: pointer;
  }
  ::selection { background: rgba(0,122,255,0.22); }
`;

function useScale(w: number, h: number, pad = 48): number {
  const [scale, setScale] = React.useState(1);
  React.useLayoutEffect(() => {
    const fit = () => setScale(Math.min((window.innerWidth - pad) / w, (window.innerHeight - pad) / h, 1));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [w, h]);
  return scale;
}

// ── traffic lights (no sidebar, onboarding chrome)
function TrafficLights() {
  return (
    <div style={{ display: 'flex', gap: 8, position: 'absolute', top: 18, left: 20, zIndex: 30 }}>
      {['#ff5f57', '#febc2e', '#28c840'].map(c => (
        <span key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c, border: '0.5px solid rgba(0,0,0,0.12)' }} />
      ))}
    </div>
  );
}

// ── step dots
interface StepperProps {
  step: number;
  maxVisited: number;
  onJump: (i: number) => void;
}

function Stepper({ step, maxVisited, onJump }: StepperProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginBottom: 26 }}>
      {[0, 1, 2, 3, 4].map(i => {
        const done = i < step, current = i === step;
        const clickable = i <= maxVisited;
        return (
          <button key={i} onClick={() => clickable && onJump(i)} aria-label={`Step ${i + 1}`}
            style={{ padding: 4, cursor: clickable ? 'pointer' : 'default', lineHeight: 0 }}>
            <span style={{
              display: 'grid', placeItems: 'center',
              width: current ? 26 : 8, height: 8, borderRadius: 'var(--r-pill)',
              background: done ? 'var(--green)' : current ? 'var(--blue)' : 'var(--fill-secondary)',
              border: (done || current) ? 'none' : '0.5px solid var(--separator-strong)',
              transition: 'width 320ms var(--spring), background 220ms ease',
            }}>
              {done && <Icon name="check" size={6} stroke={3.5} style={{ color: '#fff' }} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── shared step heading
interface StepHeadingProps {
  icon: IconName;
  tint: string;
  title: string;
  sub: string;
}

function StepHeading({ icon, tint, title, sub }: StepHeadingProps) {
  return (
    <div style={{ marginBottom: 18 }}>
      <span style={{
        display: 'inline-grid', placeItems: 'center', width: 40, height: 40, borderRadius: 11,
        background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint, marginBottom: 12,
      }}>
        <Icon name={icon} size={22} />
      </span>
      <h2 style={{ margin: '0 0 6px', font: '700 var(--fs-title2)/1.15 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{title}</h2>
      <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' } as React.CSSProperties}>{sub}</p>
    </div>
  );
}

// ── deterministic pseudo-QR (looks like a real QR, with finder patterns)
function QRCode({ size = 156 }: { size?: number }) {
  const N = 25, cell = size / N;
  // seeded RNG
  let s = 1337;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const isFinder = (r: number, c: number) => {
    const inBox = (br: number, bc: number) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
    return inBox(0, 0) || inBox(0, N - 7) || inBox(N - 7, 0);
  };
  const cells: React.ReactNode[] = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (isFinder(r, c)) continue;
    if (rnd() > 0.52) cells.push(<rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} rx={cell * 0.18} />);
  }
  const finder = (x: number, y: number) => (
    <g>
      <rect x={x} y={y} width={cell * 7} height={cell * 7} rx={cell * 1.6} fill="none" stroke="#000" strokeWidth={cell} />
      <rect x={x + cell * 2} y={y + cell * 2} width={cell * 3} height={cell * 3} rx={cell * 0.9} fill="#000" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="#000" shapeRendering="crispEdges">
      {cells}
      {finder(0, 0)}
      {finder(size - cell * 7, 0)}
      {finder(0, size - cell * 7)}
    </svg>
  );
}

// ── Step 1: Welcome
function WelcomeStep() {
  return (
    <div style={{ textAlign: 'center', paddingTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 26 }}>
        <div style={{ filter: 'drop-shadow(0 16px 32px rgba(90,70,200,0.35))' }}>
          <MaestroMark size={104} />
        </div>
      </div>
      <h1 style={{
        margin: '0 0 12px', font: '700 var(--fs-large-title)/1.08 var(--font-display)',
        letterSpacing: '-0.02em', color: 'var(--ink)',
      }}>One operator.<br />A fleet of agents.</h1>
      <p style={{
        margin: '0 auto', maxWidth: 360, font: '400 var(--fs-body)/1.45 var(--font-text)',
        color: 'var(--ink-secondary)', textWrap: 'pretty',
      } as React.CSSProperties}>Maestro is your command deck for AI work — projects, schedulers, studio, and budgets, run from one calm place.</p>
    </div>
  );
}

// ── Step 2: Workspace
interface WorkspaceStepProps {
  value: string;
  onChange: (next: string) => void;
}

function WorkspaceStep({ value, onChange }: WorkspaceStepProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { const t = setTimeout(() => ref.current && ref.current.focus(), 360); return () => clearTimeout(t); }, []);
  return (
    <div>
      <StepHeading icon="folder" tint="var(--blue)"
        title="Name your workspace"
        sub="Everything in Maestro lives under one workspace — yours." />
      <GroupedList footer="You can rename it later in Settings.">
        <Row last style={{ padding: '4px 14px' }}>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', width: 92, flexShrink: 0 }}>Name</span>
          <input ref={ref} value={value} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
            placeholder="e.g. Atlas Studio"
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink)',
              padding: '14px 0',
            }} />
        </Row>
      </GroupedList>
    </div>
  );
}

// ── Step 3: Connect providers
type ProviderKey = 'anthropic' | 'openai';
type ProviderState = 'idle' | 'waiting' | 'connected' | 'error';

interface ProvidersStepProps {
  providers: Record<ProviderKey, ProviderState>;
  keys: Record<ProviderKey, string>;
  errors: Record<ProviderKey, string>;
  onKeyChange: (key: ProviderKey, val: string) => void;
  onConnect: (key: ProviderKey) => void;
}

function ProvidersStep({ providers, keys, errors, onKeyChange, onConnect }: ProvidersStepProps) {
  const rows: { key: ProviderKey; name: string; meta: string; glyph: React.ReactNode; brand: string; hint: string }[] = [
    { key: 'anthropic', name: 'Anthropic', meta: 'Claude · coding & reasoning', glyph: <AnthropicGlyph size={24} />, brand: '#D97757', hint: 'sk-ant-…' },
    { key: 'openai', name: 'OpenAI', meta: 'GPT · media & vision', glyph: <OpenAIGlyph size={22} />, brand: 'var(--ink)', hint: 'sk-…' },
  ];
  return (
    <div>
      <StepHeading icon="key" tint="var(--indigo)"
        title="Connect your providers"
        sub="Paste your API key — agents run on your own account." />
      <GroupedList footer={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Icon name="lock" size={13} style={{ flexShrink: 0, marginTop: 1, opacity: 0.7 }} />
          <span>Keys are validated live, then stored encrypted on your server. Agents use them, never see them. You can also do this later in Settings.</span>
        </span>}>
        {rows.map((r, idx) => {
          const st = providers[r.key];
          const connected = st === 'connected';
          return (
            <Row key={r.key} last={idx === rows.length - 1}>
              <span style={{
                width: 38, height: 38, borderRadius: 9, flexShrink: 0,
                display: 'grid', placeItems: 'center', color: r.brand,
                background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)',
              }}>{r.glyph}</span>
              <span style={{ flexShrink: 0, width: 92 }}>
                <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{r.name}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1.3 var(--font-text)', color: errors[r.key] ? 'var(--red)' : 'var(--ink-secondary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {errors[r.key] || r.meta}
                </span>
              </span>
              {connected ? (
                <span style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                  <StatusPill state="connected" />
                </span>
              ) : (
                <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                  <input
                    type="password" value={keys[r.key]} placeholder={r.hint}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => onKeyChange(r.key, e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter' && keys[r.key].trim()) onConnect(r.key); }}
                    style={{ flex: 1, minWidth: 0, maxWidth: 168, height: 34, border: '0.5px solid var(--separator-strong)', borderRadius: 8, outline: 'none', background: 'var(--fill-tertiary)', font: '400 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', padding: '0 10px' }} />
                  {st === 'waiting'
                    ? <StatusPill state="waiting" />
                    : <PillButton kind="plain" disabled={!keys[r.key].trim()} onClick={() => onConnect(r.key)}
                        style={{ height: 34, padding: '0 14px', fontSize: 14,
                          background: st === 'error' ? 'rgba(255,59,48,0.12)' : 'var(--fill-secondary)',
                          color: st === 'error' ? 'var(--red)' : 'var(--blue)' }}>
                        {st === 'error' ? 'Retry' : 'Connect'}
                      </PillButton>}
                </span>
              )}
            </Row>
          );
        })}
      </GroupedList>
    </div>
  );
}

// ── Step 4: Budget ceiling
interface BudgetStepProps {
  amount: number;
  onAmount: (next: number) => void;
}

function BudgetStep({ amount, onAmount }: BudgetStepProps) {
  const min = 20, max = 1000;
  const pct = ((amount - min) / (max - min)) * 100;
  const runs = Math.round(amount / 5);
  const minutes = (amount / 40).toFixed(1).replace(/\.0$/, '');
  return (
    <div>
      <StepHeading icon="gauge" tint="var(--green)"
        title="Set your budget ceiling"
        sub="A hard cap. Jobs stop at the line — never a surprise bill." />
      <div style={{
        background: 'var(--bg-grouped)', borderRadius: 'var(--r-group)',
        border: '0.5px solid var(--separator)', padding: '22px 22px 20px',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ font: '500 32px/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>$</span>
          <input
            type="text" inputMode="numeric" value={amount}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { const v = parseInt(e.target.value.replace(/\D/g, '') || '0', 10); onAmount(Math.min(max, Math.max(min, v))); }}
            style={{
              width: 'auto', minWidth: 40, maxWidth: 150, fieldSizing: 'content',
              border: 'none', outline: 'none', background: 'transparent', textAlign: 'center',
              font: '600 56px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)',
            } as React.CSSProperties} />
          <span style={{ font: '500 17px/1 var(--font-text)', color: 'var(--ink-secondary)' }}>/ month</span>
        </div>
        <input type="range" min={min} max={max} step={5} value={amount}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onAmount(parseInt(e.target.value, 10))}
          style={{
            width: '100%', margin: '18px 0 16px', height: 28, WebkitAppearance: 'none',
            background: `linear-gradient(var(--blue),var(--blue)) 0/${pct}% 100% no-repeat var(--fill-secondary)`,
            borderRadius: 'var(--r-pill)', appearance: 'none', cursor: 'pointer',
          }} className="ios-slider" />
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px',
            borderRadius: 'var(--r-pill)', background: 'var(--fill-tertiary)',
            border: '0.5px solid var(--separator)',
            font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)',
          }}>
            <Icon name="spark" size={15} style={{ color: 'var(--purple)' }} />
            ≈ <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{runs}</b> deep coding runs
            &nbsp;·&nbsp; <b style={{ color: 'var(--ink)', fontWeight: 600 }}>{minutes}</b> video min
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Step 5: Pair your phone
interface PairStepProps {
  secondsLeft: number;
  onRefresh: () => void;
}

function PairStep({ secondsLeft, onRefresh }: PairStepProps) {
  const expired = secondsLeft <= 0;
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const frac = secondsLeft / 120;
  return (
    <div>
      <StepHeading icon="smartphone" tint="var(--teal)"
        title="Pair your phone"
        sub="Approve jobs and watch runs from anywhere. Optional — you can do this later." />
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <div style={{
          position: 'relative', width: 176, height: 176, flexShrink: 0,
          background: '#fff', borderRadius: 18, padding: 16,
          boxShadow: '0 8px 28px rgba(0,0,0,0.12)', border: '0.5px solid var(--separator)',
        }}>
          <QRCode size={144} />
          {expired && (
            <div style={{
              position: 'absolute', inset: 0, borderRadius: 18, display: 'grid', placeItems: 'center',
              background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
            }}>
              <button onClick={onRefresh} style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 16px',
                borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff',
                font: '600 var(--fs-subhead)/1 var(--font-text)',
              }}><Icon name="refresh" size={15} /> Refresh code</button>
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ font: '600 var(--fs-headline)/1.25 var(--font-text)', color: 'var(--ink)', letterSpacing: '-0.01em' }}>Scan with the Maestro app</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
                <circle cx="12" cy="12" r="9" fill="none" stroke="var(--fill-secondary)" strokeWidth="3" />
                <circle cx="12" cy="12" r="9" fill="none" stroke={expired ? 'var(--red)' : 'var(--teal)'} strokeWidth="3"
                  strokeLinecap="round" strokeDasharray={2 * Math.PI * 9} strokeDashoffset={2 * Math.PI * 9 * (1 - frac)}
                  style={{ transition: 'stroke-dashoffset 1s linear' }} />
              </svg>
              <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', whiteSpace: 'nowrap', color: expired ? 'var(--red)' : 'var(--ink-secondary)' }}>
                {expired ? 'Code expired' : `Expires in ${mm}:${ss}`}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {['Open Maestro on iPhone', 'Tap Pair a device', 'Point it at this code'].map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{
                  width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--fill-secondary)', color: 'var(--ink-secondary)',
                  display: 'grid', placeItems: 'center', font: '600 11px/1 var(--font-mono)',
                }}>{i + 1}</span>
                <span style={{ font: '400 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── A glimpse of the Command Center dashboard that resolves behind the
//    dissolving setup card on the final step.
interface DashboardPeekProps {
  workspace: string;
  budget: number;
}

function DashboardPeek({ workspace, budget }: DashboardPeekProps) {
  const nav: { icon: IconName; label: string; active?: boolean }[] = [
    { icon: 'bolt', label: 'Command Center', active: true },
    { icon: 'folder', label: 'Projects' },
    { icon: 'cpu', label: 'Job monitor' },
    { icon: 'shield', label: 'Approvals' },
    { icon: 'image', label: 'Media studio' },
    { icon: 'gauge', label: 'Budget' },
  ];
  const jobs = [
    { name: 'Refactor auth service', state: 'Building', tint: 'var(--purple)', pct: 64, cost: '$0.42' },
    { name: 'Draft launch thread', state: 'Reviewing', tint: 'var(--teal)', pct: 88, cost: '$0.12' },
    { name: 'Weekly trend digest', state: 'Waiting for you', tint: 'var(--orange)', pct: 100, cost: '$0.07' },
  ];
  const spent = Math.min(budget * 0.34, budget);
  const ring = 2 * Math.PI * 26;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'var(--bg)' }}>
      {/* sidebar */}
      <div style={{
        width: 220, flexShrink: 0, padding: '52px 12px 16px',
        background: 'var(--bg-grouped)', backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
        borderRight: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', gap: 2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 8px 16px' }}>
          <MaestroMark size={26} />
          <span style={{ font: '700 15px/1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Maestro</span>
        </div>
        {nav.map(n => (
          <div key={n.label} style={{
            display: 'flex', alignItems: 'center', gap: 10, height: 34, padding: '0 10px', borderRadius: 8,
            background: n.active ? 'var(--blue)' : 'transparent',
            color: n.active ? '#fff' : 'var(--ink-secondary)',
            font: '500 var(--fs-subhead)/1 var(--font-text)',
          }}>
            <Icon name={n.icon} size={17} /> {n.label}
          </div>
        ))}
      </div>
      {/* main */}
      <div style={{ flex: 1, padding: '52px 28px 24px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 4 }}>{workspace || 'Your workspace'}</div>
            <div style={{ font: '700 var(--fs-large-title)/1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>Good evening</div>
          </div>
          <EffortDial value="DEEP" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Live jobs</div>
            {jobs.map(j => (
              <div key={j.name} style={{
                background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
                padding: 14, boxShadow: 'var(--card-shadow)', display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ width: 9, height: 9, borderRadius: 5, background: j.tint, flexShrink: 0, boxShadow: `0 0 0 4px color-mix(in srgb, ${j.tint} 18%, transparent)` }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{j.name}</div>
                  <div style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: j.tint, marginTop: 3 }}>{j.state}</div>
                </div>
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>{j.cost}</span>
              </div>
            ))}
          </div>
          <div style={{
            background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)',
            padding: 18, boxShadow: 'var(--card-shadow)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          }}>
            <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', alignSelf: 'flex-start' }}>This month</div>
            <svg width="120" height="120" viewBox="0 0 64 64" style={{ transform: 'rotate(-90deg)', margin: '4px 0' }}>
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--fill-secondary)" strokeWidth="7" />
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--green)" strokeWidth="7" strokeLinecap="round"
                strokeDasharray={ring} strokeDashoffset={ring * (1 - spent / budget)} />
            </svg>
            <div style={{ font: '600 var(--fs-title2)/1 var(--font-mono)', color: 'var(--ink)' }}>${spent.toFixed(0)}</div>
            <div style={{ font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>of ${budget} cap</div>
          </div>
        </div>
      </div>
    </div>
  );
}

type Theme = 'light' | 'dark';
type Phase = 'card' | 'finishing' | 'done';

export default function Onboarding() {
  const navigate = useNavigate();
  const scale = useScale(WIN_W, WIN_H);
  const [theme, setTheme] = React.useState<Theme>('light');
  const [step, setStep] = React.useState(0);
  const [maxVisited, setMaxVisited] = React.useState(0);
  const [dir, setDir] = React.useState<'' | 'fwd' | 'back'>('');
  const [phase, setPhase] = React.useState<Phase>('card');

  const [workspace, setWorkspace] = React.useState('');
  const [providers, setProviders] = React.useState<Record<ProviderKey, ProviderState>>({ anthropic: 'idle', openai: 'idle' });
  const [keys, setKeys] = React.useState<Record<ProviderKey, string>>({ anthropic: '', openai: '' });
  const [providerErrors, setProviderErrors] = React.useState<Record<ProviderKey, string>>({ anthropic: '', openai: '' });
  const [budget, setBudget] = React.useState(200);
  const [secondsLeft, setSecondsLeft] = React.useState(120);
  const openaiTries = React.useRef(0);

  React.useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // pairing countdown
  React.useEffect(() => {
    if (step !== 4 || phase !== 'card') return;
    setSecondsLeft(120);
    const t = setInterval(() => setSecondsLeft(s => (s <= 0 ? 0 : s - 1)), 1000);
    return () => clearInterval(t);
  }, [step, phase]);

  const go = (next: number) => {
    if (next === step) return;
    setDir(next > step ? 'fwd' : 'back');
    setStep(next);
    setMaxVisited(m => Math.max(m, next));
  };

  const connect = async (key: ProviderKey) => {
    const apiKey = keys[key].trim();
    if (!apiKey) return;
    setProviders(p => ({ ...p, [key]: 'waiting' }));
    setProviderErrors(e => ({ ...e, [key]: '' }));
    try {
      await api.connectProvider(key, apiKey);
      setProviders(p => ({ ...p, [key]: 'connected' }));
    } catch (err) {
      setProviders(p => ({ ...p, [key]: 'error' }));
      setProviderErrors(e => ({ ...e, [key]: err instanceof ApiError ? err.message : 'Connection failed' }));
    }
  };

  const finish = () => {
    setPhase('finishing');
    try {
      localStorage.setItem('maestro.onboarded', '1');
      localStorage.setItem('maestro.budget', String(budget));
      if (workspace.trim()) localStorage.setItem('maestro.workspace', workspace.trim());
    } catch {
      /* storage may be unavailable */
    }
    // Persist the workspace on the live backend — best-effort, never blocks setup.
    if (workspace.trim()) void api.createWorkspace(workspace.trim()).catch(() => {});
    window.setTimeout(() => navigate('/command-center'), 1500);
  };
  const restart = () => {
    setPhase('card'); setStep(0); setMaxVisited(0); setWorkspace('');
    setProviders({ anthropic: 'idle', openai: 'idle' }); setBudget(200);
    openaiTries.current = 0;
  };

  const canContinue = [true, workspace.trim().length > 0, true, true, true][step];

  const steps: React.ReactNode[] = [
    <WelcomeStep />,
    <WorkspaceStep value={workspace} onChange={setWorkspace} />,
    <ProvidersStep providers={providers} keys={keys} errors={providerErrors} onKeyChange={(k, v) => setKeys(s => ({ ...s, [k]: v }))} onConnect={connect} />,
    <BudgetStep amount={budget} onAmount={setBudget} />,
    <PairStep secondsLeft={secondsLeft} onRefresh={() => setSecondsLeft(120)} />,
  ];

  const continueLabel = ['Get started', 'Continue', 'Continue', 'Continue', 'Finish setup'][step];

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
      <style>{styles}</style>
      <div style={{
        width: '100%', height: '100%', overflow: 'hidden', position: 'relative',
        background: 'var(--backdrop-base)',
      }}>
        {/* animated backdrop */}
        <div className="backdrop" aria-hidden="true">
          <span className="blob b1" /><span className="blob b2" /><span className="blob b3" />
          <span className="grain" />
        </div>
        {/* appearance toggle */}
        <div style={{ position: 'absolute', top: 16, right: 18, zIndex: 30, display: 'flex', gap: 2, padding: 3,
          borderRadius: 'var(--r-pill)', background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          {([['light', 'sun'], ['dark', 'moon']] as [Theme, IconName][]).map(([t, ic]) => (
            <button key={t} onClick={() => setTheme(t)} style={{
              width: 30, height: 26, borderRadius: 'var(--r-pill)', display: 'grid', placeItems: 'center',
              background: theme === t ? 'var(--bg-elevated)' : 'transparent',
              color: theme === t ? 'var(--ink)' : 'var(--on-glass)',
              boxShadow: theme === t ? '0 1px 3px rgba(0,0,0,0.18)' : 'none', transition: 'all 200ms ease',
            }}><Icon name={ic} size={15} /></button>
          ))}
        </div>

        {/* dashboard behind */}
        {phase !== 'card' && (
          <div className="dash-wrap" data-phase={phase}>
            <DashboardPeek workspace={workspace} budget={budget} />
          </div>
        )}

        {/* finishing flourish */}
        {phase === 'finishing' && (
          <div className="youre-set">
            <span style={{ display: 'inline-grid', placeItems: 'center', width: 56, height: 56, borderRadius: '50%',
              background: 'var(--green)', color: '#fff', marginBottom: 16, boxShadow: '0 10px 30px rgba(52,199,89,0.4)' }}>
              <Icon name="check" size={30} stroke={3} />
            </span>
            <div style={{ font: '700 var(--fs-title1)/1.1 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>You're set</div>
          </div>
        )}

        {/* the card */}
        {phase === 'card' && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 40, zIndex: 20 }}>
            <div className="glass-card">
              <Stepper step={step} maxVisited={maxVisited} onJump={go} />
              <div className="card-body" key={step} data-dir={dir}>
                {steps[step]}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 30, minHeight: 44 }}>
                <div>
                  {step > 0 && (
                    <PillButton kind="quiet" onClick={() => go(step - 1)}>
                      <Icon name="arrowLeft" size={16} style={{ marginRight: 2 }} /> Back
                    </PillButton>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {step === 4 && (
                    <PillButton kind="quiet" onClick={finish}>Skip for now</PillButton>
                  )}
                  <PillButton kind="primary" disabled={!canContinue}
                    onClick={() => (step === 4 ? finish() : go(step + 1))}
                    icon={step === 4 ? undefined : 'arrowRight'}>
                    {continueLabel}
                  </PillButton>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* restart affordance when done */}
        {phase === 'done' && (
          <button onClick={restart} style={{
            position: 'absolute', bottom: 20, right: 22, zIndex: 40, display: 'inline-flex', alignItems: 'center', gap: 7,
            height: 36, padding: '0 14px', borderRadius: 'var(--r-pill)',
            background: 'var(--glass-tint)', border: '0.5px solid var(--glass-border)', color: 'var(--ink)',
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            font: '500 var(--fs-subhead)/1 var(--font-text)',
          }}>
            <Icon name="refresh" size={15} /> Replay setup
          </button>
        )}
      </div>
    </div>
  );
}
