/* Media Studio — left brief & controls panel. */

const STUDIO_STAGES = ['Brief', 'Voice', 'Avatar', 'B-roll', 'Captions', 'Music', 'Assemble', 'Publish'];

const LANES = {
  draft: { label: 'Draft lane', tint: 'var(--ink-secondary)', bg: 'var(--fill-secondary)' },
  hero: { label: 'Hero lane', tint: 'var(--teal)', bg: 'color-mix(in srgb, var(--teal) 14%, transparent)' },
  selfhost: { label: 'Self-host', tint: 'var(--green)', bg: 'color-mix(in srgb, var(--green) 13%, transparent)' },
};

function LaneChips({ value, onChange }) {
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

function MiniStepper({ label, value, set, suffix, min = 1, max = 999, step = 1 }) {
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

function PanelSection({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function VoiceRow({ name, tag, playing, onPlay, selected, onSelect }) {
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

function BriefPanel({ lane, setLane, dur, setDur, est, voice, setVoice, playing, setPlaying }) {
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

Object.assign(window, { STUDIO_STAGES, LANES, LaneChips, MiniStepper, BriefPanel });
