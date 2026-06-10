/* Session Transcript — assembly: header, 3-col layout, streaming tail,
   auto-scroll + jump-to-live pill, run-state switch (live/gate/done/failed). */

const LIVE_TAIL = 'Patching the three call sites in routes/ that read req.session directly. Each now resolves the JWT first and falls back to the legacy cookie only when the token is absent, so existing sessions keep working through the rollout.';

function Typewriter({ text, live, onTick }) {
  const [n, setN] = React.useState(live ? 0 : text.length);
  React.useEffect(() => {
    if (!live) { setN(text.length); return; }
    setN(0);
    const words = text.split(' ');
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setN(words.slice(0, i).join(' ').length);
      onTick && onTick();
      if (i >= words.length) clearInterval(t);
    }, 90);
    return () => clearInterval(t);
  }, [text, live]);
  return <Narration streamed={text.slice(0, n)} live={live} />;
}

function transcriptBlocks(runState, onApprove, onChanges, onTick) {
  const blocks = [];
  blocks.push(<PhaseMarker key="pm-plan" phase="Plan" tint="var(--blue)" />);
  blocks.push(<SystemRow key="sys" icon="refresh" text="Resumed from checkpoint after sleep" />);
  blocks.push(<Narration key="n1" text="I'll move the auth service to short-lived JWTs while keeping the legacy cookie path intact. Plan: add a jwt_id column, issue tokens on login, and update the three read sites behind a fallback." />);
  blocks.push(<ToolCall key="t1" tool="read" cmd="src/auth/session.ts" time="0.3s" ok stdout={"export async function getSession(req) {\n  const sid = req.cookies['sid'];\n  return store.get(sid); // ← legacy path\n}"} />);
  blocks.push(<Thinking key="th" tokens="1.4k" text="The cookie path is read in three places. If I gate on the presence of a bearer token first, I can roll out JWTs without breaking active sessions. Migration must be reversible." />);

  blocks.push(<PhaseMarker key="pm-build" phase="Build" tint="var(--purple)" />);
  blocks.push(<Narration key="n2" text="The session table needs a migration. Adding a nullable jwt_id column so we can backfill without downtime." />);
  blocks.push(<DiffCard key="d1" file="migrations/0042_add_jwt_id.sql" add={18} del={0} hunks={[
    { t: 'ctx', c: 'ALTER TABLE sessions' },
    { t: 'add', c: "  ADD COLUMN jwt_id text;" },
    { t: 'add', c: "CREATE INDEX idx_sessions_jwt" },
    { t: 'add', c: "  ON sessions (jwt_id);" },
  ]} />);
  blocks.push(<ToolCall key="t2" tool="bash" cmd="npm test -- auth" time="3.2s" ok stdout={"PASS  test/auth/session.test.ts\nPASS  test/auth/jwt.test.ts\n\nTests: 24 passed, 24 total\nTime:  3.18 s"} />);
  blocks.push(<ToolCall key="t3" tool="bash" cmd="npm run typecheck" time="5.1s" ok stdout={"tsc --noEmit\n✓ 0 errors"} />);

  if (runState === 'live') {
    blocks.push(<Typewriter key="tail" text={LIVE_TAIL} live onTick={onTick} />);
  }
  if (runState === 'gate') {
    blocks.push(<Narration key="n3" text="Patched all three call sites behind a token-first fallback. Tests green, typecheck clean. Opening the PR for your review." />);
    blocks.push(<PhaseMarker key="pm-rev" phase="Review" tint="var(--teal)" />);
    blocks.push(<Narration key="n4" text="Reviewer pass complete — no blocking issues. One note: consider rotating the signing key quarterly. Handing off to the merge gate." />);
    blocks.push(<GateCard key="gate" onApprove={onApprove} onChanges={onChanges} />);
  }
  if (runState === 'done') {
    blocks.push(<Narration key="n3" text="Patched all three call sites, reviewer signed off, and you approved the merge. Shipped to main." />);
    blocks.push(<SummaryCard key="sum" kind="done" />);
  }
  if (runState === 'failed') {
    blocks.push(<Narration key="n3" text="Wiring the token signer into the login route…" />);
    blocks.push(<SummaryCard key="sum" kind="failed" />);
  }
  return blocks;
}

function SessionTranscript() {
  const [theme, setTheme] = useTheme('light');
  const [runState, setRunState] = React.useState('live');
  const [cost, setCost] = React.useState(0.42);
  const [tokens] = React.useState('31.8k');
  const [elapsed, setElapsed] = React.useState(252); // seconds
  const [atBottom, setAtBottom] = React.useState(true);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const scrollRef = React.useRef(null);

  const live = runState === 'live';

  // live tickers
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      setCost(c => +(c + 0.003 + Math.random() * 0.004).toFixed(3));
      setElapsed(e => e + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [live]);

  React.useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const scrollToLive = () => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); };
  const onScroll = () => { const el = scrollRef.current; if (!el) return; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60); };
  const followStream = () => { const el = scrollRef.current; if (el && atBottom) el.scrollTop = el.scrollHeight; };

  const mm = Math.floor(elapsed / 60), ss = String(elapsed % 60).padStart(2, '0');

  const statusMap = {
    live: { label: 'Building', tint: 'var(--purple)', pulse: true },
    gate: { label: 'Waiting at gate', tint: 'var(--orange)', pulse: false },
    done: { label: 'Completed', tint: 'var(--green)', pulse: false },
    failed: { label: 'Failed', tint: 'var(--red)', pulse: false },
  }[runState];

  const jumpTo = (phase) => { const el = document.getElementById(`phase-${phase}`); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); };

  return (
    <WindowFrame>
      <Sidebar active="jobs" onNav={navTo} onWorkspace={() => {}} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative', zIndex: 1 }}>
        <Toolbar theme={theme} setTheme={setTheme} onSearch={() => setPaletteOpen(true)} budget={{ spent: 38.20, cap: 200, animateKey: 0 }} />

        {/* job header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', borderBottom: '0.5px solid var(--separator)',
          background: 'color-mix(in srgb, var(--bg) 86%, transparent)', position: 'relative', zIndex: 5 }}>
          <a href="../job-monitor/Job Monitor.html" className="split-quiet" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center',
            background: 'var(--fill-secondary)', color: 'var(--ink)', textDecoration: 'none', flexShrink: 0 }}><Icon name="arrowLeft" size={17} /></a>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 4 }}>
              <span>Atlas API</span><Icon name="chevronRight" size={12} style={{ color: 'var(--ink-tertiary)' }} /><span style={{ color: 'var(--ink)', fontWeight: 600 }}>Refactor auth service</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
                background: `color-mix(in srgb, ${statusMap.tint} 15%, transparent)`, color: statusMap.tint, font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
                <span className={statusMap.pulse ? 'breathe' : ''} style={{ width: 7, height: 7, borderRadius: 4, background: statusMap.tint }} /> {statusMap.label}
              </span>
              <span style={{ font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>ran at</span>
              <EffortDial value="DEEP" compact />
            </div>
          </div>
          {/* state switch (demo of run states) */}
          <div style={{ display: 'inline-flex', padding: 2, background: 'var(--fill-secondary)', borderRadius: 9 }}>
            {[['live', 'Live'], ['gate', 'At gate'], ['done', 'Done'], ['failed', 'Failed']].map(([k, label]) => (
              <button key={k} onClick={() => setRunState(k)} style={{ padding: '6px 12px', borderRadius: 7, font: '600 var(--fs-footnote)/1 var(--font-text)',
                background: runState === k ? 'var(--bg-elevated)' : 'transparent', color: runState === k ? 'var(--ink)' : 'var(--ink-secondary)',
                boxShadow: runState === k ? '0 1px 3px rgba(0,0,0,0.14)' : 'none', transition: 'all 160ms ease' }}>{label}</button>
            ))}
          </div>
          <button className="tb-icon" title="Share / export" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0 }}>
            <Icon name="enter" size={18} style={{ transform: 'rotate(-90deg)' }} />
          </button>
        </div>

        {/* 3-col body */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <RunOutline runState={runState} onJump={jumpTo} />

          {/* center transcript */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            {runState === 'gate' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 24px', background: 'rgba(255,149,0,0.12)', borderBottom: '0.5px solid rgba(255,149,0,0.3)' }}>
                <Icon name="enter" size={17} style={{ color: 'var(--orange)', flexShrink: 0 }} />
                <span style={{ font: '600 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}>Waiting for your approval</span>
                <span style={{ font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--orange)' }}>· 12 min</span>
              </div>
            )}
            <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '24px 24px 80px' }}>
              <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
                {transcriptBlocks(runState, () => setRunState('done'), () => setRunState('failed'), followStream)}
              </div>
            </div>

            {/* jump to live pill */}
            {live && !atBottom && (
              <button onClick={scrollToLive} className="jump-pill" style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 6,
                display: 'inline-flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)',
                background: 'var(--blue)', color: '#fff', font: '600 var(--fs-subhead)/1 var(--font-text)', boxShadow: '0 8px 24px rgba(0,122,255,0.4)' }}>
                Jump to live <Icon name="chevronDown" size={15} />
              </button>
            )}
          </div>

          <RightRail runState={runState} cost={cost} tokens={tokens} elapsed={`${mm}:${ss}`} onPause={() => setRunState('gate')} onCancel={() => setRunState('failed')} />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </WindowFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<SessionTranscript />);
