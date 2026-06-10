/* Media Studio — page assembly. Pipeline stepper, brief & controls panel,
   center canvas (video / assemble / consent gate), render queue, cost estimate,
   ⌘K palette. Ported to ES-module TypeScript React — visual output unchanged. */

import React from 'react';
import { AppShell } from '../lib/appShell';
import { Icon, type IconName } from '../lib/icons';
import { Spinner } from '../lib/ui';

/* ───────────────────────── page-specific CSS (from <Page>.html) ───────────────────────── */
const styles = `
  .breathe { animation: breathe 1.8s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
  .render-ring { animation: spin 1.4s linear infinite; transform-origin: 30px 30px; }
  .est-num { animation: estPulse 360ms var(--spring); }
  @keyframes estPulse { 0% { transform: translateY(-2px); } 100% { transform: none; } }
  .canvas-fade { animation: cfade 240ms var(--spring); }
  @keyframes cfade { from { transform: translateY(6px); } to { transform: none; } }
  @keyframes paletteFade { from { opacity: 0.3; } to { opacity: 1; } }
  @keyframes palettePop { from { transform: translateY(-12px) scale(0.985); } to { transform: none; } }
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .step-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 55%, var(--ink) 8%); }
  .pipe-stage:hover { filter: brightness(0.98); }
  .voice-row:hover, .filmstrip:hover, .tpl-thumb:hover, .asset-cell:hover { filter: brightness(1.02); }
  .pipe-scroll::-webkit-scrollbar { height: 0; }
`;

/* ───────────────────────── shared data ───────────────────────── */

const STUDIO_STAGES = ['Brief', 'Voice', 'Avatar', 'B-roll', 'Captions', 'Music', 'Assemble', 'Publish'];

interface Lane {
  label: string;
  tint: string;
  bg: string;
}

const LANES: Record<string, Lane> = {
  draft: { label: 'Draft lane', tint: 'var(--ink-secondary)', bg: 'var(--fill-secondary)' },
  hero: { label: 'Hero lane', tint: 'var(--teal)', bg: 'color-mix(in srgb, var(--teal) 14%, transparent)' },
  selfhost: { label: 'Self-host', tint: 'var(--green)', bg: 'color-mix(in srgb, var(--green) 13%, transparent)' },
};

/* ───────────────────────── ⌘K command palette (from cc-palette.jsx) ───────────────────────── */

interface PaletteItem {
  group: string;
  icon: IconName;
  label: string;
  hint: string;
}

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

/* ───────────────────────── pipeline stepper ───────────────────────── */

function PipelineStepper({ active, onPick, done }: { active: string; onPick: (s: string) => void; done: string[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', padding: '2px 0' }} className="pipe-scroll">
      {STUDIO_STAGES.map((s, i) => {
        const isDone = done.includes(s);
        const isActive = active === s;
        return (
          <React.Fragment key={s}>
            {i > 0 && <span style={{ width: 14, height: 2, borderRadius: 1, background: isDone || (done.includes(STUDIO_STAGES[i - 1])) ? 'var(--teal)' : 'var(--separator)', flexShrink: 0 }} />}
            <button onClick={() => onPick(s)} className="pipe-stage" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', flexShrink: 0,
              background: isActive ? 'var(--teal)' : isDone ? 'color-mix(in srgb, var(--teal) 14%, transparent)' : 'var(--fill-secondary)',
              color: isActive ? '#fff' : isDone ? 'var(--teal)' : 'var(--ink-tertiary)',
              font: `${isActive ? 700 : 600} var(--fs-footnote)/1 var(--font-text)`,
              boxShadow: isActive ? '0 0 0 4px color-mix(in srgb, var(--teal) 16%, transparent)' : 'none', transition: 'all 160ms ease' }}>
              {isDone && <Icon name="check" size={12} stroke={3} />}
              {isActive && <span className="breathe" style={{ width: 6, height: 6, borderRadius: 3, background: '#fff' }} />}
              {s}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ───────────────────────── consent gate ───────────────────────── */

function ConsentGate({ stage, onRecord, onClose }: { stage: string; onRecord: () => void; onClose: () => void }) {
  return (
    <div style={{ maxWidth: 520, margin: '40px auto 0', background: 'var(--bg-elevated)', borderRadius: 18, border: '1px solid rgba(255,149,0,0.4)',
      boxShadow: '0 0 0 4px rgba(255,149,0,0.10), var(--card-shadow)', padding: 26, textAlign: 'center' }}>
      <span style={{ display: 'inline-grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', marginBottom: 16 }}><Icon name="shield" size={26} /></span>
      <h2 style={{ margin: '0 0 8px', font: '700 var(--fs-title2)/1.2 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Consent required before cloning</h2>
      <p style={{ margin: '0 0 20px', font: '400 var(--fs-body)/1.5 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>
        The <b style={{ color: 'var(--ink)' }}>{stage}</b> stage clones a real voice or likeness. Record a consent statement from the person before Maestro will generate anything.
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button onClick={onClose} style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-callout)/1 var(--font-text)' }}>Pick another stage</button>
        <button onClick={onRecord} className="primary-cta" style={{ height: 42, padding: '0 20px', borderRadius: 'var(--r-pill)', background: 'var(--orange)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', boxShadow: '0 6px 18px rgba(255,149,0,0.32)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Icon name="play" size={16} /> Record consent now
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── left brief & controls panel ───────────────────────── */

function LaneChips({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {Object.entries(LANES).map(([k, l]) => {
        const on = value === k;
        return (
          <button key={k} onClick={() => onChange(k)} style={{ flex: 1, padding: '7px 4px', borderRadius: 9, font: '600 var(--fs-caption)/1 var(--font-text)',
            background: on ? l.bg : 'transparent', color: on ? l.tint : 'var(--ink-tertiary)', border: `1px solid ${on ? 'color-mix(in srgb, ' + l.tint + ' 35%, transparent)' : 'var(--separator)'}`, transition: 'all 140ms ease' }}>
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

function MiniStepper({ label, value, set, suffix, min = 1, max = 999, step = 1 }: {
  label: string; value: number; set: (v: number) => void; suffix?: string; min?: number; max?: number; step?: number;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1, font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{label}</span>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, background: 'var(--fill-secondary)', borderRadius: 8 }}>
        <button onClick={() => set(Math.max(min, value - step))} className="step-btn" style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 16px/1 var(--font-text)' }}>−</button>
        <span style={{ minWidth: 48, textAlign: 'center', font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>{value}{suffix}</span>
        <button onClick={() => set(Math.min(max, value + step))} className="step-btn" style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink)', font: '600 16px/1 var(--font-text)' }}>+</button>
      </div>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function VoiceRow({ name, tag, playing, onPlay, selected, onSelect }: {
  name: string; tag: string; playing: boolean; onPlay: () => void; selected: boolean; onSelect: () => void;
}) {
  return (
    <div onClick={onSelect} className="voice-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', borderRadius: 10, cursor: 'pointer',
      background: selected ? 'color-mix(in srgb, var(--teal) 10%, transparent)' : 'var(--fill-tertiary)', border: `1px solid ${selected ? 'color-mix(in srgb, var(--teal) 35%, transparent)' : 'var(--separator)'}` }}>
      <button onClick={e => { e.stopPropagation(); onPlay(); }} style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', color: 'var(--teal)' }}>
        <Icon name={playing ? 'pause' : 'play'} size={13} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: '600 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>{name}</div>
        <div style={{ font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>{tag}</div>
      </div>
      {selected && <Icon name="check" size={15} stroke={2.6} style={{ color: 'var(--teal)' }} />}
    </div>
  );
}

function BriefPanel({ lane, setLane, dur, setDur, est, voice, setVoice, playing, setPlaying }: {
  lane: string; setLane: (k: string) => void; dur: number; setDur: (v: number) => void; est: number;
  voice: number; setVoice: (v: number) => void; playing: number; setPlaying: (v: number) => void;
}) {
  const breakdown = [
    { label: 'Voice · 24s', cost: 0.18 }, { label: 'Avatar · hero', cost: 3.20 }, { label: 'B-roll · 4 clips', cost: 2.40 },
    { label: 'Captions', cost: 0.10 }, { label: 'Music', cost: 0.30 }, { label: 'Assemble · render', cost: est - 6.18 },
  ];
  const [open, setOpen] = React.useState(false);
  const amber = est > 12;
  return (
    <aside style={{ width: 320, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        <PanelSection title="Brief">
          <div style={{ background: 'var(--bg-elevated)', borderRadius: 12, border: '0.5px solid var(--separator)', padding: 13, font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink)' }}>
            A 24-second vertical explainer: “How Maestro runs a fleet of agents while you sleep.” Calm, confident VO. Cinematic city-at-night B-roll. End on the logo.
          </div>
        </PanelSection>

        <PanelSection title="Model lane">
          <LaneChips value={lane} onChange={setLane} />
          <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 7 }}>
            {lane === 'hero' ? 'Veo 3 · highest fidelity' : lane === 'selfhost' ? 'Wan 2.2 · your GPU, no per-second cost' : 'LTX · fast drafts at $0.02/s'}
          </div>
        </PanelSection>

        <PanelSection title="Output">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <MiniStepper label="Duration" value={dur} set={setDur} suffix="s" min={5} max={120} step={1} />
            <MiniStepper label="Resolution" value={1080} set={() => {}} suffix="p" />
          </div>
        </PanelSection>

        <PanelSection title="Voice">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <VoiceRow name="Atlas — warm narrator" tag="ElevenLabs · en-US" playing={playing === 0} onPlay={() => setPlaying(playing === 0 ? -1 : 0)} selected={voice === 0} onSelect={() => setVoice(0)} />
            <VoiceRow name="Nova — bright, upbeat" tag="ElevenLabs · en-US" playing={playing === 1} onPlay={() => setPlaying(playing === 1 ? -1 : 1)} selected={voice === 1} onSelect={() => setVoice(1)} />
          </div>
        </PanelSection>
      </div>

      {/* cost estimate pinned */}
      <div style={{ flexShrink: 0, borderTop: '0.5px solid var(--separator)', padding: 16, background: 'var(--bg-grouped)' }}>
        <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', width: '100%', marginBottom: open ? 12 : 0 }}>
          <div style={{ textAlign: 'left' }}>
            <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 5 }}>Estimated cost</div>
            <div key={est} className="est-num" style={{ font: '700 32px/1 var(--font-mono)', letterSpacing: '-0.02em', color: amber ? 'var(--orange)' : 'var(--ink)' }}>≈ ${est.toFixed(2)}</div>
          </div>
          <span style={{ flex: 1 }} />
          <Icon name="chevronDown" size={18} style={{ color: 'var(--ink-tertiary)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms var(--spring)' }} />
        </button>
        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 12, borderTop: '0.5px solid var(--separator)' }}>
            {breakdown.map((b, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', font: '500 var(--fs-footnote)/1 var(--font-mono)' }}>
                <span style={{ color: 'var(--ink-secondary)' }}>{b.label}</span><span style={{ color: 'var(--ink)' }}>${b.cost.toFixed(2)}</span>
              </div>
            ))}
          </div>
        )}
        {amber && <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--orange)' }}><Icon name="alert" size={13} /> Above this project's comfort threshold ($12).</div>}
      </div>
    </aside>
  );
}

/* ───────────────────────── center canvas: video / assemble ───────────────────────── */

function VideoCanvas({ heroIdx, setHeroIdx, rendering }: { heroIdx: number; setHeroIdx: (i: number) => void; rendering: boolean }) {
  const drafts = [
    { tint: 'linear-gradient(135deg,#1b2a4a,#0E2A5E)', cps: '0.02' },
    { tint: 'linear-gradient(135deg,#0E2A5E,#30B0C7)', cps: '0.02' },
    { tint: 'linear-gradient(135deg,#2a1b4a,#5856D6)', cps: '0.02' },
    { tint: 'linear-gradient(135deg,#1b3a2a,#1F8A5B)', cps: '0.02' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, maxWidth: 560, margin: '0 auto', width: '100%' }}>
      {/* player */}
      <div style={{ width: 300, position: 'relative' }}>
        <div style={{ width: 300, height: 533, borderRadius: 20, background: rendering ? 'var(--fill-secondary)' : drafts[heroIdx].tint, overflow: 'hidden', position: 'relative',
          boxShadow: 'var(--card-shadow), 0 20px 60px rgba(15,20,60,0.2)', border: '0.5px solid var(--separator)', display: 'grid', placeItems: 'center' }}>
          {rendering ? (
            <div style={{ textAlign: 'center', filter: 'none' }}>
              <svg width="60" height="60" viewBox="0 0 60 60" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx="30" cy="30" r="25" fill="none" stroke="var(--fill-secondary)" strokeWidth="5" />
                <circle className="render-ring" cx="30" cy="30" r="25" fill="none" stroke="var(--teal)" strokeWidth="5" strokeLinecap="round" strokeDasharray={157} strokeDashoffset={62} />
              </svg>
              <div style={{ font: '600 var(--fs-subhead)/1.3 var(--font-text)', color: 'var(--ink)', marginTop: 12 }}>Rendering on fal · ~90s</div>
              <div style={{ font: '400 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 4 }}>Continues in the background</div>
            </div>
          ) : (
            <React.Fragment>
              <span style={{ width: 64, height: 64, borderRadius: '50%', background: 'rgba(255,255,255,0.2)', backdropFilter: 'blur(6px)', display: 'grid', placeItems: 'center', color: '#fff' }}><Icon name="play" size={28} /></span>
              <span style={{ position: 'absolute', top: 14, left: 14, display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 9px', borderRadius: 'var(--r-pill)', background: 'rgba(0,0,0,0.4)', color: '#fff', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Hero · {heroIdx + 1}</span>
            </React.Fragment>
          )}
        </div>
        {/* scrubber */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>0:08</span>
          <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--fill-secondary)', position: 'relative' }}>
            <div style={{ width: '34%', height: '100%', borderRadius: 2, background: 'var(--teal)' }} />
            <span style={{ position: 'absolute', left: '34%', top: '50%', transform: 'translate(-50%,-50%)', width: 13, height: 13, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }} />
          </div>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>0:24</span>
        </div>
      </div>

      {/* filmstrip */}
      <div style={{ width: '100%' }}>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Draft variants</div>
        <div style={{ display: 'flex', gap: 10 }}>
          {drafts.map((d, i) => (
            <button key={i} onClick={() => setHeroIdx(i)} className="filmstrip" style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ width: '100%', aspectRatio: '9/16', borderRadius: 10, background: d.tint, border: `2px solid ${heroIdx === i ? 'var(--teal)' : 'transparent'}`, position: 'relative', overflow: 'hidden' }}>
                {heroIdx === i && <span style={{ position: 'absolute', bottom: 5, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4, height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)', background: 'var(--teal)', color: '#fff', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Re-render hero</span>}
              </div>
              <div style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', marginTop: 5, textAlign: 'center' }}>Draft · ${d.cps}/s</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function AssembleCanvas() {
  const tracks = [
    { label: 'Video', tint: 'var(--teal)', clips: [{ w: 30 }, { w: 25 }, { w: 28 }] },
    { label: 'Captions', tint: 'var(--blue)', clips: [{ w: 20 }, { w: 18 }, { w: 22 }, { w: 19 }] },
    { label: 'Music', tint: 'var(--purple)', clips: [{ w: 92 }] },
  ];
  const templates = ['Bold kinetic', 'Clean lower-third', 'Word-pop', 'Minimal'];
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', width: '100%' }}>
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 18, marginBottom: 18 }}>
        <div style={{ font: '600 var(--fs-callout)/1 var(--font-text)', color: 'var(--ink)', marginBottom: 14 }}>Remotion timeline</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {tracks.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 64, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', flexShrink: 0 }}>{t.label}</span>
              <div style={{ flex: 1, display: 'flex', gap: 4 }}>
                {t.clips.map((c, j) => <div key={j} style={{ width: `${c.w}%`, height: 30, borderRadius: 6, background: `color-mix(in srgb, ${t.tint} 22%, var(--bg-elevated))`, border: `1px solid color-mix(in srgb, ${t.tint} 45%, transparent)` }} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Kinetic-typography template</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10 }}>
        {templates.map((t, i) => (
          <button key={i} className="tpl-thumb" style={{ textAlign: 'center' }}>
            <div style={{ width: '100%', aspectRatio: '16/10', borderRadius: 10, background: i === 0 ? 'color-mix(in srgb, var(--teal) 16%, var(--bg-elevated))' : 'var(--fill-tertiary)', border: `2px solid ${i === 0 ? 'var(--teal)' : 'var(--separator)'}`, display: 'grid', placeItems: 'center', marginBottom: 6 }}>
              <span style={{ font: '800 18px/1 var(--font-display)', color: i === 0 ? 'var(--teal)' : 'var(--ink-tertiary)' }}>Aa</span>
            </div>
            <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>{t}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── right render queue ───────────────────────── */

function StudioQueue() {
  const q = [
    { stage: 'B-roll · clip 3', status: 'rendering', cost: '0.60' },
    { stage: 'Voice · take 2', status: 'done', cost: '0.18' },
    { stage: 'Avatar · hero', status: 'wait', cost: '3.20' },
    { stage: 'Captions', status: 'done', cost: '0.10' },
  ];
  const assets = ['linear-gradient(135deg,#0E2A5E,#30B0C7)', 'linear-gradient(135deg,#2a1b4a,#5856D6)', 'linear-gradient(135deg,#1b3a2a,#1F8A5B)', 'linear-gradient(135deg,#3a2a1b,#FF9500)', 'linear-gradient(135deg,#1b2a4a,#007AFF)', 'linear-gradient(135deg,#3a1b2a,#AF52DE)'];
  return (
    <aside style={{ width: 300, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', overflowY: 'auto',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ padding: 18 }}>
        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 11 }}>Render queue</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {q.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)' }}>
              <span style={{ flexShrink: 0 }}>
                {r.status === 'rendering' ? <Spinner size={14} color="var(--teal)" /> : r.status === 'wait' ? <Spinner size={14} color="var(--orange)" /> : <Icon name="check" size={14} stroke={2.6} style={{ color: 'var(--green)' }} />}
              </span>
              <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.stage}{r.status === 'wait' && <span style={{ color: 'var(--orange)', fontSize: 'var(--fs-caption)' }}> · webhook</span>}</span>
              <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-secondary)' }}>${r.cost}</span>
            </div>
          ))}
        </div>

        <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', margin: '20px 0 11px' }}>Asset bin</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          {assets.map((a, i) => (
            <div key={i} className="asset-cell" style={{ aspectRatio: '1', borderRadius: 9, background: a, border: '0.5px solid var(--separator)', cursor: 'grab' }} />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--green)' }}>
          <Icon name="shield" size={12} /> C2PA ✓ · SynthID ✓ on every asset
        </div>
      </div>
    </aside>
  );
}

/* ───────────────────────── page root ───────────────────────── */

export default function MediaStudio() {
  const [active, setActive] = React.useState('B-roll');
  const [lane, setLane] = React.useState('hero');
  const [dur, setDur] = React.useState(24);
  const [voice, setVoice] = React.useState(0);
  const [playing, setPlaying] = React.useState(-1);
  const [heroIdx, setHeroIdx] = React.useState(0);
  const [consentDone, setConsentDone] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  // cost estimate reacts to controls
  const base = lane === 'hero' ? 0.32 : lane === 'selfhost' ? 0.04 : 0.10;
  const est = +(2.9 + dur * base + (voice === 1 ? 0.4 : 0)).toFixed(2);

  const done = ['Brief', 'Voice'];
  const needsConsent = (active === 'Avatar' || active === 'Voice') && !consentDone;

  return (
    <AppShell
      active="studio"
      onSearch={() => setPaletteOpen(true)}
      budget={{ spent: 38.20, cap: 200, animateKey: 0 }}
    >
      <style>{styles}</style>

      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* top: context + pipeline */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', borderBottom: '0.5px solid var(--separator)', background: 'color-mix(in srgb, var(--bg) 86%, transparent)', position: 'relative', zIndex: 5 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--teal) 12%, transparent)', color: 'var(--teal)', font: '600 var(--fs-footnote)/1 var(--font-text)', flexShrink: 0 }}>
            <Icon name="clapper" size={14} /> Q3 Content · Launch film
          </span>
          <div style={{ flex: 1, minWidth: 0 }}><PipelineStepper active={active} onPick={s => { setActive(s); }} done={done} /></div>
        </div>

        {/* 3 columns */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <BriefPanel lane={lane} setLane={setLane} dur={dur} setDur={setDur} est={est} voice={voice} setVoice={setVoice} playing={playing} setPlaying={setPlaying} />
          <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '28px 28px', display: 'flex', flexDirection: 'column' }} key={active} className="canvas-fade">
            {needsConsent ? <ConsentGate stage={active} onRecord={() => setConsentDone(true)} onClose={() => setActive('B-roll')} />
              : active === 'Assemble' ? <AssembleCanvas />
              : <VideoCanvas heroIdx={heroIdx} setHeroIdx={setHeroIdx} rendering={false} />}
          </main>
          <StudioQueue />
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </AppShell>
  );
}
