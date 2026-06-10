/* Media Studio — center canvas (video/image/render/assemble) + right queue. */

function VideoCanvas({ heroIdx, setHeroIdx, rendering }) {
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

Object.assign(window, { VideoCanvas, AssembleCanvas, StudioQueue });
