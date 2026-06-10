/* MCP Gateway — Servers, Live activity, Denials. */

const MCP_PROJ = {
  atlas: { name: 'Atlas API', color: 'var(--blue)' },
  content: { name: 'Q3 Content', color: 'var(--purple)' },
  scan: { name: 'Market Scan', color: 'var(--indigo)' },
};

const SERVERS = [
  { proj: 'atlas', name: 'GitHub', glyph: 'gh', tint: 'var(--ink)', transport: 'HTTP', tools: 12, loaded: 3, defer: true, scope: 'read-write', signed: true, on: true, ns: 'com.github.mcp' },
  { proj: 'atlas', name: 'Postgres (prod)', glyph: 'pg', tint: 'var(--teal)', transport: 'stdio', tools: 6, loaded: 2, defer: true, scope: 'read-only', signed: true, on: true, ns: 'org.postgresql.mcp' },
  { proj: 'atlas', name: 'Sentry', glyph: 'se', tint: 'var(--orange)', transport: 'HTTP', tools: 4, loaded: 0, defer: true, scope: 'read-only', signed: true, on: false, ns: 'io.sentry.mcp' },
  { proj: 'content', name: 'Linear', glyph: 'li', tint: 'var(--indigo)', transport: 'HTTP', tools: 8, loaded: 4, defer: false, scope: 'read-write', signed: true, on: true, ns: 'com.linear.mcp' },
  { proj: 'content', name: 'Notion', glyph: 'no', tint: 'var(--ink)', transport: 'HTTP', tools: 9, loaded: 2, defer: true, scope: 'read-only', signed: true, on: true, ns: 'so.notion.mcp' },
  { proj: 'scan', name: 'Brave Search', glyph: 'br', tint: 'var(--orange)', transport: 'HTTP', tools: 3, loaded: 1, defer: true, scope: 'read-only', signed: true, on: true, ns: 'com.brave.mcp' },
  { proj: 'scan', name: 'Web scraper', glyph: 'ws', tint: 'var(--ink-secondary)', transport: 'stdio', tools: 5, loaded: 0, defer: true, scope: 'read-only · isolated', signed: false, on: false, ns: 'local.scraper' },
];

function SrvGlyph({ s, size = 38 }) {
  return <span style={{ width: size, height: size, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: `color-mix(in srgb, ${s.tint} 15%, transparent)`, color: s.tint, font: '700 var(--fs-footnote)/1 var(--font-mono)', textTransform: 'uppercase' }}>{s.glyph}</span>;
}

function ServerRow({ s, last }) {
  const [on, setOn] = React.useState(s.on);
  const [defer, setDefer] = React.useState(s.defer);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderBottom: last ? 'none' : '0.5px solid var(--separator)', opacity: on ? 1 : 0.62, transition: 'opacity 220ms ease' }}>
      <SrvGlyph s={s} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ font: '600 var(--fs-callout)/1.1 var(--font-text)', color: 'var(--ink)' }}>{s.name}</span>
          <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', font: '600 var(--fs-caption)/18px var(--font-mono)', color: 'var(--ink-secondary)' }}>{s.transport}</span>
          {s.signed ? <span title="Signature verified" style={{ color: 'var(--green)' }}><Icon name="shield" size={14} /></span> : <span title="Unsigned" style={{ color: 'var(--orange)' }}><Icon name="alert" size={14} /></span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)' }}>
          <span className="tool-count" style={{ fontVariantNumeric: 'tabular-nums' }}>{s.tools} tools · {on ? s.loaded : 0} loaded</span>
          <span style={{ color: 'var(--ink-tertiary)' }}>·</span>
          <span>{s.scope}</span>
        </div>
      </div>
      {/* deferred-loading */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 6 }}>
        <span style={{ textAlign: 'right' }}>
          <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>Load on demand</span>
          <span style={{ display: 'block', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 2 }}>Saves ~85% startup tokens</span>
        </span>
        <Switch on={defer} onChange={setDefer} />
      </div>
      <span style={{ width: 1, height: 28, background: 'var(--separator)' }} />
      <Switch on={on} onChange={setOn} />
    </div>
  );
}

function ServersTab() {
  const [filter, setFilter] = React.useState('all');
  const projs = filter === 'all' ? Object.keys(MCP_PROJ) : [filter];
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button onClick={() => setFilter('all')} className="filter-chip" style={{ height: 32, padding: '0 14px', borderRadius: 'var(--r-pill)', background: filter === 'all' ? 'var(--blue)' : 'var(--fill-secondary)', color: filter === 'all' ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>All projects</button>
        {Object.entries(MCP_PROJ).map(([k, p]) => (
          <button key={k} onClick={() => setFilter(k)} className="filter-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', background: filter === k ? 'var(--blue)' : 'var(--fill-secondary)', color: filter === k ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-subhead)/1 var(--font-text)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, background: p.color }} /> {p.name}
          </button>
        ))}
      </div>

      {projs.map(pk => {
        const rows = SERVERS.filter(s => s.proj === pk);
        const p = MCP_PROJ[pk];
        return (
          <div key={pk} style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ width: 9, height: 9, borderRadius: 5, background: p.color }} />
              <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-secondary)' }}>{p.name}</span>
              <span style={{ flex: 1 }} />
              <button className="link-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)' }}><Icon name="plus" size={14} stroke={2.4} /> Add server</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: '12px 12px 0 0', background: 'var(--fill-tertiary)', border: '0.5px solid var(--separator)', borderBottom: 'none', font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
              <Icon name="lock" size={13} style={{ color: 'var(--ink-tertiary)' }} /> Deny by default — agents reach only what you allow here.
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: '0 0 12px 12px', border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
              {rows.map((s, i) => <ServerRow key={s.name} s={s} last={i === rows.length - 1} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Live activity ── */
const CALLS_SEED = [
  { job: 'atlas', server: 'github', tool: 'get_pull_request', scope: 'read', ok: true, ms: '142ms' },
  { job: 'atlas', server: 'postgres', tool: 'query', scope: 'read', ok: true, ms: '38ms' },
  { job: 'content', server: 'linear', tool: 'create_issue', scope: 'write', ok: true, ms: '210ms' },
  { job: 'scan', server: 'brave', tool: 'web_search', scope: 'read', ok: true, ms: '480ms' },
  { job: 'atlas', server: 'github', tool: 'create_commit_status', scope: 'write', ok: true, ms: '96ms' },
  { job: 'content', server: 'notion', tool: 'append_block', scope: 'write', ok: false, ms: '12ms' },
  { job: 'atlas', server: 'postgres', tool: 'list_tables', scope: 'read', ok: true, ms: '22ms' },
  { job: 'scan', server: 'brave', tool: 'news_search', scope: 'read', ok: true, ms: '512ms' },
];
const JOB_TINT = { atlas: 'var(--blue)', content: 'var(--purple)', scan: 'var(--indigo)' };

function LiveActivity() {
  const [rows, setRows] = React.useState(() => CALLS_SEED.map((c, i) => ({ ...c, id: i, t: 14 * 3600 + 8 * 60 + 22 - i * 3 })));
  const [paused, setPaused] = React.useState(false);
  const idRef = React.useRef(CALLS_SEED.length);

  React.useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      const c = CALLS_SEED[Math.floor(Math.random() * CALLS_SEED.length)];
      setRows(r => [{ ...c, id: idRef.current++, t: Math.floor(Date.now() / 1000) % 86400, fresh: true }, ...r].slice(0, 40));
    }, 1800);
    return () => clearInterval(t);
  }, [paused]);

  const fmt = s => { const h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60, sec = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, height: 40, padding: '0 14px', borderRadius: 11, background: 'var(--bg-grouped)', border: '0.5px solid var(--separator)', maxWidth: 360, backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
          <Icon name="search" size={16} style={{ color: 'var(--ink-tertiary)' }} />
          <span style={{ font: '400 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Filter by server, tool, or job</span>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: paused ? 'var(--ink-tertiary)' : 'var(--green)' }}>
          {!paused && <span className="breathe" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--green)' }} />}{paused ? 'Paused' : 'Live'}
        </span>
        <button onClick={() => setPaused(p => !p)} className="ghost-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
          <Icon name={paused ? 'play' : 'pause'} size={14} /> {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
        {rows.map((r, i) => (
          <div key={r.id} className={`call-row ${r.fresh ? 'call-fresh' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 16px', borderBottom: i < rows.length - 1 ? '0.5px solid var(--separator)' : 'none' }}>
            <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 64, flexShrink: 0 }}>{fmt(r.t)}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, width: 96, flexShrink: 0 }}><span style={{ width: 7, height: 7, borderRadius: 4, background: JOB_TINT[r.job] }} /><span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{MCP_PROJ[r.job].name}</span></span>
            <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><span style={{ color: 'var(--ink-tertiary)' }}>{r.server}.</span>{r.tool}</span>
            <span style={{ height: 20, padding: '0 8px', borderRadius: 'var(--r-pill)', background: r.scope === 'write' ? 'color-mix(in srgb, var(--orange) 13%, transparent)' : 'var(--fill-secondary)', color: r.scope === 'write' ? 'var(--orange)' : 'var(--ink-secondary)', font: '600 var(--fs-caption)/20px var(--font-text)', flexShrink: 0 }}>{r.scope}</span>
            <span style={{ font: '400 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', width: 52, textAlign: 'right', flexShrink: 0 }}>{r.ms}</span>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: r.ok ? 'var(--green)' : 'var(--red)', flexShrink: 0 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Denials ── */
const DENIALS = [
  { job: 'scan', server: 'web scraper', tool: 'fetch_url', reason: 'Not on project allowlist' },
  { job: 'atlas', server: 'github', tool: 'delete_repo', reason: 'Capability not granted' },
  { job: 'content', server: 'notion', tool: 'export_workspace', reason: 'Signature drift' },
  { job: 'atlas', server: 'postgres', tool: 'drop_table', reason: 'Capability not granted' },
];
function DenialsTab({ onAllow }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', boxShadow: 'var(--card-shadow)' }}>
      {DENIALS.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderBottom: i < DENIALS.length - 1 ? '0.5px solid var(--separator)' : 'none', background: 'rgba(255,59,48,0.03)' }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,59,48,0.12)', color: 'var(--red)' }}><Icon name="lock" size={16} /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', font: '500 var(--fs-callout)/1.1 var(--font-mono)', color: 'var(--ink)' }}><span style={{ color: 'var(--ink-tertiary)' }}>{d.server}.</span>{d.tool}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: '400 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--red)', marginTop: 3 }}>
              <Icon name="xCircle" size={12} /> {d.reason} <span style={{ color: 'var(--ink-tertiary)' }}>· {MCP_PROJ[d.job].name}</span>
            </span>
          </span>
          <button onClick={() => onAllow(d)} className="link-btn" style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--blue)', flexShrink: 0 }}>Allow for this project…</button>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { MCP_PROJ, ServersTab, LiveActivity, DenialsTab });
