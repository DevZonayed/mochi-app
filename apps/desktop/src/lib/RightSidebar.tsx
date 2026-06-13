/* The Workspace right sidebar — a VS Code / Conductor-style panel.

   Top: tabbed All files (lazy codebase tree) · Changes (files the active chat
   wrote) · Checks (the reviewer's verdicts from SP3). Bottom: a collapsible
   Setup / Run / Terminal dock that runs shell commands in the project folder
   and streams the output. The whole sidebar collapses to a thin rail. */

import React from 'react';
import { Icon } from './icons';
import { api, type Project, type DirEntry, type CmdOutput } from './api';

export interface CheckItem { id: string; title: string; verdict: 'approved' | 'needs-work'; text: string }

/* ── lazy file tree node ──────────────────────────────────────────────── */
function DirNode({ projectId, entry, depth, onOpenFile }: { projectId: string; entry: DirEntry; depth: number; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<DirEntry[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const toggle = () => {
    if (entry.kind !== 'dir') { onOpenFile(entry.path); return; }
    const next = !open; setOpen(next);
    if (next && children === null) {
      setLoading(true);
      api.listDir(projectId, entry.path).then(r => setChildren(r?.entries ?? [])).catch(() => setChildren([])).finally(() => setLoading(false));
    }
  };
  return (
    <div>
      <button onClick={toggle} className="ws-row" title={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: `4px 8px 4px ${10 + depth * 12}px`, borderRadius: 6, cursor: 'pointer' }}>
        {entry.kind === 'dir'
          ? <Icon name="chevronRight" size={12} style={{ color: 'var(--ink-tertiary)', flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms var(--spring)' }} />
          : <Icon name="file" size={12} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-caption)/1.45 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
      </button>
      {open && (
        <div>
          {loading && <div style={{ padding: `2px 8px 2px ${10 + (depth + 1) * 12}px`, font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>…</div>}
          {children?.map(c => <DirNode key={c.path} projectId={projectId} entry={c} depth={depth + 1} onOpenFile={onOpenFile} />)}
        </div>
      )}
    </div>
  );
}

/* ── command runner (shared by Setup / Run / Terminal) ────────────────── */
function useRunner(projectId: string | undefined) {
  const [text, setText] = React.useState('');
  const [runId, setRunId] = React.useState<string | null>(null);
  const runIdRef = React.useRef<string | null>(null);
  runIdRef.current = runId;
  React.useEffect(() => {
    const unsub = api.onCmdOutput((p: CmdOutput) => {
      if (p.runId !== runIdRef.current) return;
      if (p.stream === 'exit') { setText(t => `${t}\n[process exited ${p.code ?? ''}]\n`); setRunId(null); }
      else setText(t => `${t}${p.chunk}`.slice(-60000));
    });
    return unsub;
  }, []);
  const run = async (cmd: string) => {
    if (!projectId || !cmd.trim()) return;
    setText(t => `${t}\n$ ${cmd}\n`);
    try { const r = await api.runCommand(projectId, cmd); if (r) setRunId(r.runId); }
    catch (e) { setText(t => `${t}${e instanceof Error ? e.message : String(e)}\n`); }
  };
  const stop = () => { if (runId) { void api.killCommand(runId); setRunId(null); } };
  const clear = () => setText('');
  return { text, running: !!runId, run, stop, clear };
}

function OutputView({ text }: { text: string }) {
  const ref = React.useRef<HTMLPreElement>(null);
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return (
    <pre ref={ref} style={{ flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: '8px 12px', font: '400 11.5px/1.55 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {text || ''}
    </pre>
  );
}

type DockTab = 'setup' | 'run' | 'terminal';
const DOCK_TABS: { key: DockTab; label: string; ph: string; store?: string }[] = [
  { key: 'setup', label: 'Setup', ph: 'e.g. pnpm install', store: 'maestro.setup.' },
  { key: 'run', label: 'Run', ph: 'e.g. pnpm dev', store: 'maestro.run.' },
  { key: 'terminal', label: 'Terminal', ph: 'type a command…' },
];

function CommandDock({ projectId, open, onToggle }: { projectId: string; open: boolean; onToggle: () => void }) {
  const [tab, setTab] = React.useState<DockTab>('run');
  const runner = useRunner(projectId);
  // Persisted setup/run scripts per project; terminal is freeform.
  const keyFor = (t: DockTab) => `${DOCK_TABS.find(d => d.key === t)?.store ?? ''}${projectId}`;
  const [scripts, setScripts] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    const next: Record<string, string> = {};
    for (const d of DOCK_TABS) if (d.store) { try { next[d.key] = localStorage.getItem(keyFor(d.key)) || ''; } catch { /* ignore */ } }
    setScripts(next);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [term, setTerm] = React.useState('');
  const meta = DOCK_TABS.find(d => d.key === tab)!;
  const cmd = tab === 'terminal' ? term : (scripts[tab] ?? '');
  const setCmd = (v: string) => {
    if (tab === 'terminal') { setTerm(v); return; }
    setScripts(s => ({ ...s, [tab]: v }));
    try { localStorage.setItem(keyFor(tab), v); } catch { /* ignore */ }
  };
  const submit = () => { if (!cmd.trim()) return; runner.run(cmd); if (tab === 'terminal') setTerm(''); };

  return (
    <div style={{ flexShrink: 0, borderTop: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', height: open ? 230 : 38 }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 38, flexShrink: 0, padding: '0 6px', gap: 2 }}>
        <button onClick={onToggle} title={open ? 'Collapse' : 'Expand'} className="ws-newbtn" style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
          <Icon name="chevronDown" size={14} style={{ transform: open ? 'none' : 'rotate(180deg)', transition: 'transform 160ms ease' }} />
        </button>
        {DOCK_TABS.map(d => (
          <button key={d.key} onClick={() => { setTab(d.key); if (!open) onToggle(); }} style={{
            height: 26, padding: '0 9px', borderRadius: 7, cursor: 'pointer', font: `${tab === d.key ? 600 : 500} var(--fs-caption)/1 var(--font-text)`,
            color: tab === d.key ? 'var(--ink)' : 'var(--ink-tertiary)', background: tab === d.key && open ? 'var(--fill-secondary)' : 'transparent' }}>
            {d.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {open && runner.running && <button onClick={runner.stop} title="Stop" style={{ width: 24, height: 24, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--red)', cursor: 'pointer' }}><Icon name="square" size={13} /></button>}
        {open && <button onClick={runner.clear} title="Clear output" className="ws-newbtn" style={{ width: 24, height: 24, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)' }}><Icon name="x" size={13} /></button>}
      </div>
      {open && (
        <>
          <OutputView text={runner.text} />
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderTop: '0.5px solid var(--separator)' }}>
            <span style={{ font: '600 12px/1 var(--font-mono)', color: 'var(--green)', flexShrink: 0 }}>$</span>
            <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder={meta.ph}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', font: '400 12px/1 var(--font-mono)', color: 'var(--ink)' }} />
            <button onClick={runner.running ? runner.stop : submit} disabled={!runner.running && !cmd.trim()}
              title={runner.running ? 'Stop' : 'Run'} style={{ width: 28, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', flexShrink: 0, cursor: (runner.running || cmd.trim()) ? 'pointer' : 'default',
                background: runner.running ? 'color-mix(in srgb, var(--red) 14%, transparent)' : cmd.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: runner.running ? 'var(--red)' : cmd.trim() ? '#fff' : 'var(--ink-tertiary)' }}>
              <Icon name={runner.running ? 'square' : 'play'} size={13} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ── the sidebar ──────────────────────────────────────────────────────── */
type TopTab = 'files' | 'changes' | 'checks';

export function RightSidebar({ project, changed, checks, onOpenFile, collapsed, onToggleCollapse }: {
  project: Project; changed: string[]; checks: CheckItem[]; onOpenFile: (path: string) => void; collapsed: boolean; onToggleCollapse: () => void;
}) {
  const [tab, setTab] = React.useState<TopTab>('files');
  const [root, setRoot] = React.useState<DirEntry[] | null>(null);
  const [err, setErr] = React.useState('');
  const [q, setQ] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [dockOpen, setDockOpen] = React.useState(false);

  const loadRoot = React.useCallback(() => {
    setRoot(null); setErr('');
    api.listDir(project.id, '').then(r => setRoot(r?.entries ?? [])).catch(e => setErr(e instanceof Error ? e.message : 'Could not read folder'));
  }, [project.id]);
  React.useEffect(() => { loadRoot(); }, [loadRoot]);

  if (collapsed) {
    return (
      <div style={{ width: 38, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', background: 'var(--bg-grouped)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 8 }}>
        <button onClick={onToggleCollapse} title="Show files panel" className="ws-newbtn" style={{ width: 28, height: 28, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-secondary)' }}>
          <Icon name="sidebar" size={16} />
        </button>
        {changed.length > 0 && <div title={`${changed.length} changed`} style={{ marginTop: 2, width: 18, height: 18, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--green) 16%, transparent)', color: 'var(--green)', font: '700 9px/1 var(--font-mono)' }}>{changed.length}</div>}
      </div>
    );
  }

  const rootFiltered = q && root ? root.filter(e => e.name.toLowerCase().includes(q.toLowerCase())) : root;
  const failing = checks.filter(c => c.verdict === 'needs-work').length;

  return (
    <div style={{ width: 290, flexShrink: 0, borderLeft: '0.5px solid var(--separator)', background: 'var(--bg-grouped)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* top: tabs + actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 42, flexShrink: 0, padding: '0 6px', borderBottom: '0.5px solid var(--separator)' }}>
        {([['files', 'All files', 0], ['changes', 'Changes', changed.length], ['checks', 'Checks', checks.length]] as [TopTab, string, number][]).map(([k, label, n]) => (
          <button key={k} onClick={() => setTab(k)} style={{ height: 28, padding: '0 9px', borderRadius: 7, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
            font: `${tab === k ? 600 : 500} var(--fs-footnote)/1 var(--font-text)`, color: tab === k ? 'var(--ink)' : 'var(--ink-tertiary)', background: tab === k ? 'var(--fill-secondary)' : 'transparent' }}>
            {label}{n > 0 && <span style={{ font: '600 var(--fs-caption)/1 var(--font-mono)', color: k === 'checks' && failing ? 'var(--orange)' : 'var(--ink-tertiary)' }}>{n}</span>}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {tab === 'files' && (
          <>
            <button onClick={() => setSearching(s => !s)} title="Search files" className="ws-newbtn" style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'transparent', color: searching ? 'var(--ink)' : 'var(--ink-tertiary)' }}><Icon name="search" size={14} /></button>
            <button onClick={loadRoot} title="Refresh" className="ws-newbtn" style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)' }}><Icon name="refresh" size={13} /></button>
          </>
        )}
        <button onClick={onToggleCollapse} title="Hide panel" className="ws-newbtn" style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)' }}><Icon name="sidebar" size={15} /></button>
      </div>

      {/* body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'files' && (
          <>
            {searching && (
              <div style={{ flexShrink: 0, padding: '8px 10px', borderBottom: '0.5px solid var(--separator)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 30, padding: '0 9px', borderRadius: 8, background: 'var(--fill-secondary)' }}>
                  <Icon name="search" size={13} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
                  <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Filter top-level files…" style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }} />
                  {q && <button onClick={() => setQ('')} style={{ width: 16, height: 16, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}><Icon name="x" size={11} /></button>}
                </div>
              </div>
            )}
            <div className="ws-tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 4px 12px' }}>
              {err ? <div style={{ padding: '10px 12px', font: '400 var(--fs-caption)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>{err}</div>
                : rootFiltered === null ? <div style={{ padding: '10px 12px', font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>Loading…</div>
                : rootFiltered.length === 0 ? <div style={{ padding: '10px 12px', font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>{q ? 'No matches.' : 'Empty folder.'}</div>
                : rootFiltered.map(e => <DirNode key={e.path} projectId={project.id} entry={e} depth={0} onOpenFile={onOpenFile} />)}
            </div>
          </>
        )}
        {tab === 'changes' && (
          <div className="ws-tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 4px 12px' }}>
            {changed.length === 0
              ? <div style={{ padding: '14px 12px', font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>No changes yet — files the agent writes in this chat show up here.</div>
              : changed.map(p => (
                <button key={p} onClick={() => onOpenFile(p)} className="ws-row" title={p} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', padding: '6px 12px', cursor: 'pointer' }}>
                  <span style={{ width: 5, height: 5, borderRadius: 3, background: 'var(--green)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.split('/').pop()}</span>
                </button>
              ))}
          </div>
        )}
        {tab === 'checks' && (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {checks.length === 0
              ? <div style={{ padding: '8px 2px', font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>No checks yet — when a reviewer model checks the agent's changes, the verdicts appear here.</div>
              : checks.map(c => {
                const nw = c.verdict === 'needs-work';
                const tint = nw ? 'var(--orange)' : 'var(--green)';
                return (
                  <div key={c.id} style={{ border: `0.5px solid color-mix(in srgb, ${tint} 38%, var(--separator))`, borderRadius: 10, background: `color-mix(in srgb, ${tint} 6%, transparent)`, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                      <Icon name={nw ? 'alert' : 'checkCircle'} size={13} style={{ color: tint, flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</span>
                      <span style={{ font: '700 9px/1 var(--font-text)', letterSpacing: '0.04em', color: tint, textTransform: 'uppercase', flexShrink: 0 }}>{nw ? 'Needs work' : 'Passed'}</span>
                    </div>
                    <div style={{ font: '400 var(--fs-caption)/1.45 var(--font-text)', color: 'var(--ink-secondary)', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.text}</div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* bottom: Setup / Run / Terminal */}
      <CommandDock projectId={project.id} open={dockOpen} onToggle={() => setDockOpen(o => !o)} />
    </div>
  );
}
