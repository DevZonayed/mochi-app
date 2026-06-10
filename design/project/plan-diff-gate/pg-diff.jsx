/* Plan/Diff Gate — Mode B: diff data, file tree, diff viewer, findings rail. */

const FILES = [
  { path: 'src/auth/session.ts', add: 24, del: 8, lang: 'TS', active: true },
  { path: 'src/auth/jwt.ts', add: 40, del: 0, lang: 'TS', isNew: true },
  { path: 'src/routes/login.ts', add: 12, del: 5, lang: 'TS' },
  { path: 'migrations/0042_add_jwt_id.sql', add: 18, del: 0, lang: 'SQL', isNew: true },
  { path: 'test/auth/jwt.test.ts', add: 56, del: 0, lang: 'TS', isNew: true },
];

// diff for session.ts — {type: ctx|add|del, o: oldNo, n: newNo, c: code}
const DIFF = [
  { type: 'hunk', c: '@@ -1,9 +1,25 @@ auth/session.ts' },
  { type: 'ctx', o: 1, n: 1, c: "import { store } from '../db';" },
  { type: 'add', o: null, n: 2, c: "import { verifyJwt } from './jwt';" },
  { type: 'ctx', o: 2, n: 3, c: '' },
  { type: 'ctx', o: 3, n: 4, c: 'export async function getSession(req) {' },
  { type: 'del', o: 4, n: null, c: "  const sid = req.cookies['sid'];" },
  { type: 'del', o: 5, n: null, c: '  return store.get(sid);' },
  { type: 'add', o: null, n: 5, c: '  const bearer = req.headers.authorization?.slice(7);' },
  { type: 'add', o: null, n: 6, c: '  if (bearer) {' },
  { type: 'add', o: null, n: 7, c: '    const claims = verifyJwt(bearer);' },
  { type: 'add', o: null, n: 8, c: '    if (claims) return store.get(claims.sid);' },
  { type: 'add', o: null, n: 9, c: '  }' },
  { type: 'add', o: null, n: 10, c: '  // legacy cookie fallback during rollout' },
  { type: 'add', o: null, n: 11, c: "  const sid = req.cookies['sid'];" },
  { type: 'add', o: null, n: 12, c: '  return store.get(sid);' },
  { type: 'ctx', o: 6, n: 13, c: '}' },
  { type: 'ctx', o: 7, n: 14, c: '' },
  { type: 'del', o: 8, n: null, c: 'export function clearSession(sid) {' },
  { type: 'add', o: null, n: 15, c: 'export function clearSession(sid: string) {' },
  { type: 'ctx', o: 9, n: 16, c: '  return store.del(sid);' },
];

function FileTree({ files, active, onPick }) {
  return (
    <aside style={{ width: 240, flexShrink: 0, borderRight: '0.5px solid var(--separator)', padding: '16px 12px', overflowY: 'auto',
      background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px 12px' }}>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Changed files</span>
        <span style={{ flex: 1 }} />
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{files.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {files.map((f, i) => {
          const on = active === i;
          const parts = f.path.split('/'); const name = parts.pop(); const dir = parts.join('/') + '/';
          return (
            <button key={i} onClick={() => onPick(i)} className="file-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px', borderRadius: 8, textAlign: 'left',
              background: on ? 'var(--fill-secondary)' : 'transparent' }}>
              <Icon name="terminal" size={14} style={{ color: on ? 'var(--blue)' : 'var(--ink-tertiary)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', font: '500 var(--fs-footnote)/1.2 var(--font-mono)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>{name}</span>
                <span style={{ display: 'block', font: '400 var(--fs-caption)/1.1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dir}{f.isNew ? ' · new' : ''}</span>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0, lineHeight: 1.1 }}>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--green)' }}>+{f.add}</span>
                <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--red)' }}>−{f.del}</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function DiffViewer({ mode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: 'var(--bg-elevated)' }} className="diff-scroll">
      {/* sticky file header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px',
        background: 'var(--bg-grouped)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', borderBottom: '0.5px solid var(--separator)' }}>
        <Icon name="terminal" size={15} style={{ color: 'var(--ink-secondary)' }} />
        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-mono)', color: 'var(--ink)' }}>src/auth/session.ts</span>
        <span style={{ height: 18, padding: '0 7px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)', font: '600 var(--fs-caption)/18px var(--font-text)' }}>TypeScript</span>
        <span style={{ flex: 1 }} />
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--green)' }}>+24</span>
        <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: 'var(--red)' }}>−8</span>
      </div>

      {mode === 'unified' ? <UnifiedDiff /> : <SplitDiff />}
    </div>
  );
}

const ADD_BG = '#E8F8EE', DEL_BG = '#FDEBEC';
const ADD_BG_D = 'rgba(52,199,89,0.14)', DEL_BG_D = 'rgba(255,59,48,0.13)';

function gutter(no) {
  return <span style={{ display: 'inline-block', width: 38, flexShrink: 0, textAlign: 'right', paddingRight: 10, color: 'var(--ink-tertiary)',
    font: '400 12px/20px var(--font-mono)', userSelect: 'none' }}>{no ?? ''}</span>;
}

function UnifiedDiff() {
  return (
    <div style={{ font: '400 13px/20px var(--font-mono)', paddingBottom: 20 }}>
      {DIFF.map((l, i) => {
        if (l.type === 'hunk') return (
          <div key={i} style={{ padding: '6px 12px', background: 'var(--fill-tertiary)', color: 'var(--ink-tertiary)', font: '500 12px/1.4 var(--font-mono)', borderBottom: '0.5px solid var(--separator)' }} id="finding-anchor-top">{l.c}</div>
        );
        const isAdd = l.type === 'add', isDel = l.type === 'del';
        return (
          <div key={i} data-line={l.n} style={{ display: 'flex', alignItems: 'stretch',
            background: isAdd ? 'var(--diff-add)' : isDel ? 'var(--diff-del)' : 'transparent' }}>
            {gutter(l.o)}{gutter(l.n)}
            <span style={{ width: 16, flexShrink: 0, textAlign: 'center', color: isAdd ? 'var(--green)' : isDel ? 'var(--red)' : 'var(--ink-tertiary)' }}>{isAdd ? '+' : isDel ? '−' : ''}</span>
            <span style={{ flex: 1, whiteSpace: 'pre', paddingRight: 16, color: 'var(--ink)' }}>{l.c || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

function SplitDiff() {
  // build paired rows: ctx → both; del → left; add → right
  const left = [], right = [];
  DIFF.filter(l => l.type !== 'hunk').forEach(l => {
    if (l.type === 'ctx') { left.push(l); right.push(l); }
    else if (l.type === 'del') left.push(l);
    else right.push(l);
  });
  const rows = Math.max(left.length, right.length);
  const col = (l, side) => {
    if (!l) return <div style={{ flex: 1, minWidth: 0, background: side === 'l' ? 'transparent' : 'transparent' }} />;
    const isAdd = l.type === 'add', isDel = l.type === 'del';
    return (
      <div style={{ flex: 1, minWidth: 0, display: 'flex', background: isAdd ? 'var(--diff-add)' : isDel ? 'var(--diff-del)' : 'transparent', borderRight: side === 'l' ? '0.5px solid var(--separator)' : 'none' }}>
        {gutter(side === 'l' ? l.o : l.n)}
        <span style={{ flex: 1, whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 10, color: 'var(--ink)' }}>{l.c || ' '}</span>
      </div>
    );
  };
  return (
    <div style={{ font: '400 12.5px/20px var(--font-mono)', paddingBottom: 20 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex' }}>{col(left[i], 'l')}{col(right[i], 'r')}</div>
      ))}
    </div>
  );
}

Object.assign(window, { FILES, DIFF, FileTree, DiffViewer });
