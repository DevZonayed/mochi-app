/* The five onboarding steps. Each renders inside the glass card body.
   State + navigation are owned by app.jsx and passed in. */

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
      }}>One operator.<br/>A fleet of agents.</h1>
      <p style={{
        margin: '0 auto', maxWidth: 360, font: '400 var(--fs-body)/1.45 var(--font-text)',
        color: 'var(--ink-secondary)', textWrap: 'pretty',
      }}>Maestro is your command deck for AI work — projects, schedulers, studio, and budgets, run from one calm place.</p>
    </div>
  );
}

// ── Step 2: Workspace
function WorkspaceStep({ value, onChange }) {
  const ref = React.useRef(null);
  React.useEffect(() => { const t = setTimeout(() => ref.current && ref.current.focus(), 360); return () => clearTimeout(t); }, []);
  return (
    <div>
      <StepHeading icon="folder" tint="var(--blue)"
        title="Name your workspace"
        sub="Everything in Maestro lives under one workspace — yours." />
      <GroupedList footer="You can rename it later in Settings.">
        <Row last style={{ padding: '4px 14px' }}>
          <span style={{ font: '400 var(--fs-body)/1 var(--font-text)', color: 'var(--ink-tertiary)', width: 92, flexShrink: 0 }}>Name</span>
          <input ref={ref} value={value} onChange={e => onChange(e.target.value)}
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
function ProvidersStep({ providers, onConnect }) {
  const rows = [
    { key: 'anthropic', name: 'Anthropic', meta: 'Claude · coding & reasoning', glyph: <AnthropicGlyph size={24} />, brand: '#D97757' },
    { key: 'openai', name: 'OpenAI', meta: 'GPT · media & vision', glyph: <OpenAIGlyph size={22} />, brand: 'var(--ink)' },
  ];
  return (
    <div>
      <StepHeading icon="key" tint="var(--indigo)"
        title="Connect your providers"
        sub="Sign in once. Agents run on your accounts." />
      <GroupedList footer={
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <Icon name="lock" size={13} style={{ flexShrink: 0, marginTop: 1, opacity: 0.7 }} />
          <span>Keys are stored in your Mac's Keychain. Agents can use them but never see them.</span>
        </span>}>
        {rows.map((r, idx) => {
          const st = providers[r.key];
          return (
            <Row key={r.key} last={idx === rows.length - 1}>
              <span style={{
                width: 38, height: 38, borderRadius: 9, flexShrink: 0,
                display: 'grid', placeItems: 'center', color: r.brand,
                background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)',
              }}>{r.glyph}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)' }}>{r.name}</span>
                <span style={{ display: 'block', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>
                  {st === 'error'
                    ? <span style={{ color: 'var(--red)' }}>Connection failed — try again.</span>
                    : r.meta}
                </span>
              </span>
              {st === 'connected'
                ? <StatusPill state="connected" />
                : st === 'waiting'
                  ? <StatusPill state="waiting" />
                  : <PillButton kind="plain" onClick={() => onConnect(r.key)}
                      style={{ height: 34, padding: '0 16px', fontSize: 14,
                        background: st === 'error' ? 'rgba(255,59,48,0.12)' : 'var(--fill-secondary)',
                        color: st === 'error' ? 'var(--red)' : 'var(--blue)' }}>
                      {st === 'error' ? 'Retry' : 'Connect'}
                    </PillButton>}
            </Row>
          );
        })}
      </GroupedList>
    </div>
  );
}

// ── Step 4: Budget ceiling
function BudgetStep({ amount, onAmount }) {
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
            onChange={e => { const v = parseInt(e.target.value.replace(/\D/g, '') || '0', 10); onAmount(Math.min(max, Math.max(min, v))); }}
            style={{
              width: 'auto', minWidth: 40, maxWidth: 150, fieldSizing: 'content',
              border: 'none', outline: 'none', background: 'transparent', textAlign: 'center',
              font: '600 56px/1 var(--font-mono)', letterSpacing: '-0.02em', color: 'var(--ink)',
            }} />
          <span style={{ font: '500 17px/1 var(--font-text)', color: 'var(--ink-secondary)' }}>/ month</span>
        </div>
        <input type="range" min={min} max={max} step={5} value={amount}
          onChange={e => onAmount(parseInt(e.target.value, 10))}
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
function PairStep({ secondsLeft, onRefresh }) {
  const expired = secondsLeft <= 0;
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, '0');
  const R = 120, C = 2 * Math.PI * (R / 2 - 3);
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

// ── shared step heading
function StepHeading({ icon, tint, title, sub }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <span style={{
        display: 'inline-grid', placeItems: 'center', width: 40, height: 40, borderRadius: 11,
        background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint, marginBottom: 12,
      }}>
        <Icon name={icon} size={22} />
      </span>
      <h2 style={{ margin: '0 0 6px', font: '700 var(--fs-title2)/1.15 var(--font-display)', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{title}</h2>
      <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink-secondary)', textWrap: 'pretty' }}>{sub}</p>
    </div>
  );
}

// ── deterministic pseudo-QR (looks like a real QR, with finder patterns)
function QRCode({ size = 156 }) {
  const N = 25, cell = size / N;
  // seeded RNG
  let s = 1337;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const isFinder = (r, c) => {
    const inBox = (br, bc) => r >= br && r < br + 7 && c >= bc && c < bc + 7;
    return inBox(0, 0) || inBox(0, N - 7) || inBox(N - 7, 0);
  };
  const cells = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (isFinder(r, c)) continue;
    if (rnd() > 0.52) cells.push(<rect key={`${r}-${c}`} x={c*cell} y={r*cell} width={cell} height={cell} rx={cell*0.18} />);
  }
  const finder = (x, y) => (
    <g>
      <rect x={x} y={y} width={cell*7} height={cell*7} rx={cell*1.6} fill="none" stroke="#000" strokeWidth={cell} />
      <rect x={x+cell*2} y={y+cell*2} width={cell*3} height={cell*3} rx={cell*0.9} fill="#000" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="#000" shapeRendering="crispEdges">
      {cells}
      {finder(0, 0)}
      {finder(size - cell*7, 0)}
      {finder(0, size - cell*7)}
    </svg>
  );
}

Object.assign(window, { WelcomeStep, WorkspaceStep, ProvidersStep, BudgetStep, PairStep, StepHeading, QRCode });
