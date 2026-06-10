/* Mobile M06 — Diff Review (summary-first, unified diff). */

const M_FINDINGS = [
  { sev: 'amber', t: 'Bearer parse assumes a "Bearer " prefix.' },
  { sev: 'grey', t: 'clearSession is now explicitly typed.' },
];
const SEVT = { red: 'var(--red)', amber: 'var(--orange)', grey: 'var(--ink-tertiary)' };
const M_DIFF = [
  { t: 'ctx', n: '1', c: "import { store } from '../db';" },
  { t: 'add', n: '2', c: "import { verifyJwt } from './jwt';" },
  { t: 'ctx', n: '', c: '··· 8 unchanged lines', fold: true },
  { t: 'ctx', n: '11', c: 'export async function getSession(req) {' },
  { t: 'del', n: '', c: "  const sid = req.cookies['sid'];" },
  { t: 'del', n: '', c: '  return store.get(sid);' },
  { t: 'add', n: '12', c: '  const bearer = req.headers.authorization?.slice(7);' },
  { t: 'add', n: '13', c: '  if (bearer) {' },
  { t: 'add', n: '14', c: '    const claims = verifyJwt(bearer);' },
  { t: 'add', n: '15', c: '    if (claims) return store.get(claims.sid);' },
  { t: 'add', n: '16', c: '  }' },
  { t: 'ctx', n: '17', c: '}' },
];

function Diff() {
  const [theme] = useTheme('light');
  return (
    <PhoneFrame noScroll>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 16px 10px', borderBottom: '0.5px solid var(--separator)' }}>
        <a href="../approvals/Approvals.html" style={{ color: 'var(--blue)' }}><Icon name="arrowLeft" size={22} /></a>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
          <div style={{ font: '500 13px/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>3 of 12 files</div>
          <div style={{ font: '600 14px/1.1 var(--font-mono)', color: 'var(--ink)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>src/auth/session.ts</div>
        </div>
        <span style={{ height: 22, padding: '0 8px', borderRadius: 11, background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)', font: '600 11px/22px var(--font-text)' }}>TS</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 96px' }} className="m-scroll">
        {/* summary card */}
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 16, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ font: '600 15px/1 var(--font-mono)', color: 'var(--green)' }}>+204</span><span style={{ font: '600 15px/1 var(--font-mono)', color: 'var(--red)' }}>−67</span>
            <span style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 10px', borderRadius: 'var(--r-pill)', background: 'rgba(255,149,0,0.14)', color: 'var(--orange)', font: '600 13px/1 var(--font-text)' }}><Icon name="alert" size={12} /> 2 issues</span>
          </div>
          <p style={{ margin: '0 0 14px', font: '400 15px/1.5 var(--font-text)', color: 'var(--ink)' }}>Moves session reads to short-lived JWTs with a legacy cookie fallback. Adds a reversible migration and 24 tests.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {M_FINDINGS.map((f, i) => (
              <button key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 10, background: 'var(--fill-tertiary)', textAlign: 'left', width: '100%' }}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: SEVT[f.sev], flexShrink: 0 }} />
                <span style={{ flex: 1, font: '400 14px/1.3 var(--font-text)', color: 'var(--ink)' }}>{f.t}</span>
                <Icon name="chevronRight" size={15} style={{ color: 'var(--ink-tertiary)' }} />
              </button>
            ))}
          </div>
        </div>
        {/* diff */}
        <div style={{ background: 'var(--bg-elevated)', borderRadius: 14, border: '0.5px solid var(--separator)', overflow: 'hidden', font: '400 12px/1.8 var(--font-mono)' }}>
          {M_DIFF.map((l, i) => l.fold ? (
            <div key={i} style={{ padding: '6px 12px', textAlign: 'center', background: 'var(--fill-tertiary)', color: 'var(--ink-tertiary)', font: '500 12px/1.4 var(--font-text)' }}>{l.c}</div>
          ) : (
            <div key={i} style={{ display: 'flex', background: l.t === 'add' ? 'var(--diff-add)' : l.t === 'del' ? 'var(--diff-del)' : 'transparent' }}>
              <span style={{ width: 30, flexShrink: 0, textAlign: 'right', paddingRight: 8, color: 'var(--ink-tertiary)', userSelect: 'none' }}>{l.n}</span>
              <span style={{ width: 14, flexShrink: 0, textAlign: 'center', color: l.t === 'add' ? 'var(--green)' : l.t === 'del' ? 'var(--red)' : 'transparent' }}>{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
              <span style={{ flex: 1, whiteSpace: 'pre', overflowX: 'auto', paddingRight: 10, color: 'var(--ink)' }}>{l.c}</span>
            </div>
          ))}
        </div>
        {/* file dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 16 }}>{Array.from({ length: 12 }).map((_, i) => <span key={i} style={{ width: 6, height: 6, borderRadius: 3, background: i === 2 ? 'var(--blue)' : 'var(--fill-secondary)' }} />)}</div>
      </div>

      {/* action bar */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 28px', background: 'var(--bg-grouped)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', borderTop: '0.5px solid var(--separator)' }}>
        <button className="m-pill" style={{ flex: 1, height: 50, borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 16px/1 var(--font-text)', boxShadow: '0 6px 18px rgba(0,122,255,0.32)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}><Icon name="lock" size={15} /> Approve &amp; merge</button>
        <button style={{ width: 50, height: 50, borderRadius: 25, background: 'var(--fill-secondary)', color: 'var(--ink-secondary)', display: 'grid', placeItems: 'center' }}><Icon name="refresh" size={19} /></button>
      </div>
    </PhoneFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Diff />);
