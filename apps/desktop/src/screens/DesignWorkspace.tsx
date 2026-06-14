/* The Design genre workspace — Maestro's agent-native design canvas (its take on
   OpenDesign): you describe what you want, the agent (Claude/Codex) builds ONE
   self-contained, live-previewable HTML artifact, refines it in place, pulls in
   generated imagery, and you can hand the result off to code. Left = the design
   conversation (the shared ChatThread, in design mode via the project's kind);
   right = a live preview served over the maestro-design:// protocol. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../lib/appShell';
import { Icon } from '../lib/icons';
import { api, IS_LOCAL, type Project, type ChatSession } from '../lib/api';
import { ChatThread } from './ProjectDetail';

const DEVICES = [
  { key: 'desktop', label: 'Desktop', w: 0, icon: 'cpu' as const },
  { key: 'tablet', label: 'Tablet', w: 834, icon: 'smartphone' as const },
  { key: 'phone', label: 'Phone', w: 390, icon: 'smartphone' as const },
];

export default function DesignWorkspace() {
  const navigate = useNavigate();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);          // bump → reload the preview iframe
  const [device, setDevice] = React.useState('desktop');
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [snap, setSnap] = React.useState<string | null>(null); // last snapshot result (toast)

  const designProjects = projects.filter(p => p.kind === 'design');
  const active = designProjects.find(p => p.id === activeId) ?? null;

  // initial load + keep the active selection valid
  React.useEffect(() => {
    let on = true;
    api.listProjects().then(ps => { if (!on) return; setProjects(ps); const ds = ps.filter(p => p.kind === 'design'); if (ds.length && !ds.some(p => p.id === activeId)) setActiveId(ds[0].id); }).catch(() => {});
    return () => { on = false; };
  }, []); // eslint-disable-line

  // sessions for the active design project — reuse the most recent, else start fresh
  React.useEffect(() => {
    if (!activeId) { setSessions([]); setSessionId(null); return; }
    let on = true;
    api.listSessions(activeId).then(ss => { if (!on) return; setSessions(ss); setSessionId(ss[0]?.id ?? null); }).catch(() => {});
    return () => { on = false; };
  }, [activeId]);

  // live preview: reload when a job for this project finishes (the agent edited the artifact)
  React.useEffect(() => {
    if (!activeId) return;
    const unsub = api.subscribe({ onJob: (j) => { if (j.projectId === activeId && (j.status === 'done' || j.status === 'running')) setNonce(n => n + 1); } });
    return () => unsub();
  }, [activeId]);

  const createDesign = async (presetName?: string) => {
    const name = (presetName || newName).trim() || `Design ${designProjects.length + 1}`;
    try {
      const p = await api.createProject({ name, kind: 'design', template: 'design', color: 'purple' });
      setProjects(ps => [...ps, p]); setActiveId(p.id); setSessionId(null); setCreating(false); setNewName('');
    } catch { /* surfaced by the empty state */ }
  };
  const doSnapshot = async () => {
    if (!active) return;
    setSnap('Saving snapshot…');
    try { const r = await api.snapshotProject(active.id, 'Design snapshot'); setSnap(r.ok ? `Snapshot saved · ${r.hash}` : (r.reason || 'snapshot failed')); }
    catch { setSnap('snapshot failed'); }
    window.setTimeout(() => setSnap(null), 4000);
  };

  const previewUrl = active ? `maestro-design://${active.id}/design/index.html?t=${nonce}` : '';
  const dev = DEVICES.find(d => d.key === device) ?? DEVICES[0];

  return (
    <AppShell active="design" onSearch={() => {}}>
      <div style={{ height: '100%', display: 'flex', minHeight: 0, background: 'var(--bg)' }}>
        {/* left rail — design projects */}
        <aside style={{ width: 200, flexShrink: 0, borderRight: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', background: 'var(--bg-grouped)' }}>
          <div style={{ padding: '12px 12px 8px', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Designs</div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
            {designProjects.map(p => {
              const on = p.id === activeId;
              return (
                <button key={p.id} onClick={() => setActiveId(p.id)} className={on ? '' : 'nav-item'} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 9, marginBottom: 1,
                  background: on ? 'var(--blue)' : 'transparent', color: on ? '#fff' : 'var(--ink)', font: `${on ? 600 : 500} var(--fs-footnote)/1.2 var(--font-text)`, cursor: 'pointer' }}>
                  <Icon name="brush" size={15} style={{ flexShrink: 0, color: on ? '#fff' : `var(--${p.color || 'purple'})` }} />
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                </button>
              );
            })}
          </div>
          <div style={{ padding: 10, borderTop: '0.5px solid var(--separator)' }}>
            {creating ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <input autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="Design name…" onKeyDown={e => { if (e.key === 'Enter') void createDesign(); if (e.key === 'Escape') setCreating(false); }}
                  style={{ flex: 1, minWidth: 0, height: 30, padding: '0 9px', borderRadius: 8, border: '1px solid var(--blue)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', outline: 'none' }} />
                <button onClick={() => void createDesign()} style={{ height: 30, padding: '0 10px', borderRadius: 8, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>Add</button>
              </div>
            ) : (
              <button onClick={() => setCreating(true)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, width: '100%', height: 34, borderRadius: 9, border: '1px dashed var(--separator-strong, var(--separator))', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>
                <Icon name="plus" size={14} /> New design
              </button>
            )}
          </div>
        </aside>

        {!active ? (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 40 }}>
            <div style={{ maxWidth: 380 }}>
              <div style={{ width: 52, height: 52, margin: '0 auto 16px', borderRadius: 14, background: 'linear-gradient(135deg, var(--blue), var(--purple, #a855f7))', display: 'grid', placeItems: 'center' }}><Icon name="brush" size={26} style={{ color: '#fff' }} /></div>
              <h2 style={{ font: '700 var(--fs-title2)/1.2 var(--font-display)', color: 'var(--ink)', margin: '0 0 8px' }}>Design with an agent</h2>
              <p style={{ font: '400 var(--fs-subhead)/1.55 var(--font-text)', color: 'var(--ink-secondary)', margin: '0 0 18px' }}>Describe what you want — a landing page, dashboard, poster, deck — and the agent builds a live, self-contained design you can refine and hand off to code.</p>
              <button onClick={() => setCreating(true)} style={{ height: 38, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-subhead)/1 var(--font-text)', cursor: 'pointer' }}>Start a design</button>
              <div style={{ marginTop: 22 }}>
                <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 10 }}>Or start from a skill</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                  {['Landing page', 'Dashboard', 'Mobile app screen', 'Slide deck', 'Poster', 'Email', 'Pricing page', 'Brand kit'].map(s => (
                    <button key={s} onClick={() => void createDesign(s)} className="nav-item" style={{ height: 32, padding: '0 13px', borderRadius: 'var(--r-pill)', border: '0.5px solid var(--separator)', background: 'var(--surface)', color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>{s}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* left: the design conversation */}
            <div style={{ width: '42%', minWidth: 360, maxWidth: 620, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '0.5px solid var(--separator)', minHeight: 0 }}>
              <ChatThread key={active.id + ':' + (sessionId ?? 'new')} flush autoFocus projectId={active.id} project={active}
                sessionId={sessionId} onSessionCreated={(s) => { setSessions(ss => ss.some(x => x.id === s.id) ? ss : [s, ...ss]); setSessionId(s.id); }}
                onTurns={() => {}} />
            </div>

            {/* right: live preview */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-elevated)' }}>
              <div style={{ height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '0.5px solid var(--separator)' }}>
                <div style={{ display: 'flex', gap: 2, background: 'var(--fill-tertiary)', borderRadius: 8, padding: 2 }}>
                  {DEVICES.map(d => (
                    <button key={d.key} onClick={() => setDevice(d.key)} title={d.label} style={{ width: 30, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', background: device === d.key ? 'var(--bg-elevated)' : 'transparent', color: device === d.key ? 'var(--ink)' : 'var(--ink-tertiary)', cursor: 'pointer' }}>
                      <Icon name={d.icon} size={d.key === 'phone' ? 13 : d.key === 'tablet' ? 15 : 16} />
                    </button>
                  ))}
                </div>
                {snap && <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: snap.includes('failed') ? 'var(--red, #e5484d)' : 'var(--green)' }}>{snap}</span>}
                <span style={{ flex: 1 }} />
                <button onClick={() => setNonce(n => n + 1)} title="Reload preview" className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="refresh" size={16} /></button>
                <button onClick={() => void doSnapshot()} title="Save a referable snapshot (commit the design + attachments)" className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="bookmark" size={16} /></button>
                {IS_LOCAL && active.path && <button onClick={() => void api.revealPath(active.path!)} title="Reveal design folder" className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="folder" size={16} /></button>}
                <button onClick={() => navigate(`/project-detail/${active.id}`)} title="Hand off to code — open this design as a coding project" style={{ display: 'flex', alignItems: 'center', gap: 7, height: 32, padding: '0 12px', borderRadius: 8, background: 'var(--ink)', color: 'var(--bg)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>
                  <Icon name="terminal" size={14} /> Hand off to code
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: dev.w ? 'start center' : 'stretch', padding: dev.w ? 20 : 0, background: dev.w ? 'var(--fill-tertiary)' : 'transparent' }}>
                <iframe key={previewUrl} title="Design preview" src={previewUrl}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  style={{ width: dev.w ? Math.min(dev.w, 1400) : '100%', height: '100%', minHeight: dev.w ? 700 : '100%', border: dev.w ? '0.5px solid var(--separator)' : 'none', borderRadius: dev.w ? 12 : 0, background: '#fff', boxShadow: dev.w ? 'var(--card-shadow)' : 'none' }} />
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
