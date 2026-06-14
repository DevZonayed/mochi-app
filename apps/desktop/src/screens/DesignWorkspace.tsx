/* The Design genre workspace — Maestro's agent-native design canvas (its take on
   OpenDesign): you describe what you want, the agent (Claude/Codex) builds ONE
   self-contained, live-previewable HTML artifact, refines it in place, pulls in
   generated imagery, and you can hand the result off to code. Left = the design
   conversation (the shared ChatThread, in design mode via the project's kind);
   right = a live preview served over the maestro-design:// protocol. The split is
   draggable (like the CodeSpace), the preview can go full-screen, and generated
   images open in an in-place modal (there's no tab system on this surface). */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../lib/appShell';
import { Icon } from '../lib/icons';
import { ImageViewer } from '../lib/CodeView';
import { api, IS_LOCAL, type Project, type ChatSession, type DesignComment } from '../lib/api';
import { ChatThread } from './ProjectDetail';

const DEVICES = [
  { key: 'desktop', label: 'Desktop', w: 0, icon: 'cpu' as const },
  { key: 'tablet', label: 'Tablet', w: 834, icon: 'smartphone' as const },
  { key: 'phone', label: 'Phone', w: 390, icon: 'smartphone' as const },
];

// Hand-off-to-code stack options (what the guided sheet asks before scaffolding).
const FRAMEWORKS = [
  { key: 'next', label: 'Next.js', hint: 'App Router' },
  { key: 'react-vite', label: 'React', hint: 'Vite' },
  { key: 'vue', label: 'Vue', hint: 'Vite' },
  { key: 'html', label: 'Plain HTML', hint: 'HTML · CSS · JS' },
];
const FRAMEWORK_LABEL: Record<string, string> = { next: 'Next.js (App Router)', 'react-vite': 'React (Vite)', vue: 'Vue 3 (Vite)', html: 'plain HTML/CSS/JS' };
const LANGS = [{ key: 'ts', label: 'TypeScript' }, { key: 'js', label: 'JavaScript' }];
const STYLINGS = [{ key: 'tailwind', label: 'Tailwind' }, { key: 'css-modules', label: 'CSS Modules' }, { key: 'plain', label: 'Plain CSS' }];
const PKGS = [{ key: 'pnpm', label: 'pnpm' }, { key: 'npm', label: 'npm' }];

function HoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.02em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', marginBottom: 7 }}>{label}</div>
      {children}
    </div>
  );
}
function HoSeg({ opts, val, onPick }: { opts: { key: string; label: string }[]; val: string; onPick: (k: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--fill-tertiary)', borderRadius: 9, padding: 3 }}>
      {opts.map(o => {
        const on = o.key === val;
        return <button key={o.key} onClick={() => onPick(o.key)} style={{ flex: 1, height: 30, borderRadius: 7, border: 'none', background: on ? 'var(--bg-elevated)' : 'transparent', color: on ? 'var(--ink)' : 'var(--ink-secondary)', font: `${on ? 600 : 500} var(--fs-caption)/1 var(--font-text)`, cursor: 'pointer', boxShadow: on ? '0 1px 2px rgba(0,0,0,.12)' : 'none' }}>{o.label}</button>;
      })}
    </div>
  );
}

/* Smoother, thinner scrollbar for the preview + image modal — the OS default
   scrollbar reads as chunky inside the canvas. Scoped via the .ds-scroll class. */
const DS_SCROLL_CSS = `
.ds-scroll { scroll-behavior: smooth; scrollbar-width: thin; scrollbar-color: var(--fill-secondary) transparent; }
.ds-scroll::-webkit-scrollbar { width: 11px; height: 11px; }
.ds-scroll::-webkit-scrollbar-track { background: transparent; }
.ds-scroll::-webkit-scrollbar-thumb { background: var(--fill-secondary); border-radius: 9px; border: 3px solid transparent; background-clip: padding-box; }
.ds-scroll::-webkit-scrollbar-thumb:hover { background: var(--ink-quaternary, var(--fill-strong, var(--ink-tertiary))); background-clip: padding-box; }
.ds-splitter { transition: background .12s ease; }
.ds-splitter:hover, .ds-splitter.dragging { background: var(--blue); }
@keyframes dsPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
.ds-pulse { animation: dsPulse 1.1s ease-in-out infinite; }
.ds-sess .ds-sess-x { opacity: 0; transition: opacity .12s ease; }
.ds-sess:hover .ds-sess-x { opacity: 1; }
.ds-sess-x:hover { color: var(--red, #e5484d) !important; }
`;

/** Compact relative timestamp for the session pills (now / 5m / 3h / 2d / 1w). */
function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

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
  const [running, setRunning] = React.useState(false);  // a run is in flight for the active design
  const [fsActive, setFsActive] = React.useState(false); // preview is in real full-screen
  // A generated/attached image opened from chat — shown in a modal (this surface
  // has no tab system, unlike the CodeSpace).
  const [modalImg, setModalImg] = React.useState<{ assetId?: string; name: string; imagePath?: string } | null>(null);
  // Resizable chat/preview split, persisted (mirrors the CodeSpace behaviour).
  const [chatW, setChatW] = React.useState<number>(() => {
    try { const v = Number(localStorage.getItem('maestro.design.chatW')); return v >= 320 && v <= 900 ? v : 460; } catch { return 460; }
  });
  const [dragging, setDragging] = React.useState(false);
  const previewRef = React.useRef<HTMLDivElement>(null);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  // Mochi-style commenting over the live preview.
  const [comments, setComments] = React.useState<DesignComment[]>([]);
  const [commentMode, setCommentMode] = React.useState(false);
  const [showComments, setShowComments] = React.useState(false);
  const [pick, setPick] = React.useState<{ selector: string; label: string } | null>(null);
  const [noteText, setNoteText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  // Refs so the iframe onLoad handler always reads the latest mode/markers.
  const commentModeRef = React.useRef(commentMode); commentModeRef.current = commentMode;
  const commentsRef = React.useRef(comments); commentsRef.current = comments;
  // Multi-session chat (a design project hosts many conversations, like the CodeSpace).
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameVal, setRenameVal] = React.useState('');
  // Hand-off-to-code: the guided "what should we build?" sheet.
  const [handoff, setHandoff] = React.useState(false);
  const [handingOff, setHandingOff] = React.useState(false);
  const [stack, setStack] = React.useState({ framework: 'next', lang: 'ts', styling: 'tailwind', pkg: 'pnpm', notes: '' });

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

  // Keep the session strip live (new/renamed/deleted sessions from any surface).
  React.useEffect(() => {
    if (!activeId) return;
    const unsub = api.subscribe({ onSession: (s) => {
      if (s.deleted) { setSessions(ss => ss.filter(x => x.id !== s.id)); setSessionId(cur => cur === s.id ? null : cur); return; }
      if (s.projectId !== activeId) return;
      setSessions(ss => {
        const next = ss.some(x => x.id === s.id) ? ss.map(x => x.id === s.id ? s : x) : [s, ...ss];
        return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
      });
    } });
    return () => unsub();
  }, [activeId]);

  // Live preview: track whether a run is in flight (so we can poll-refresh while
  // the agent writes the artifact) AND reload once it FINISHES — debounced so a
  // burst of completions coalesces into one reload. This is what makes the
  // preview auto-appear the moment a design is done, with no manual reload.
  React.useEffect(() => {
    if (!activeId) { setRunning(false); return; }
    let t: number | undefined;
    const unsub = api.subscribe({ onJob: (j) => {
      if (j.projectId !== activeId) return;
      if (j.status === 'running' || j.status === 'pending') setRunning(true);
      else {
        setRunning(false);
        if (j.status === 'done') { if (t) window.clearTimeout(t); t = window.setTimeout(() => setNonce(n => n + 1), 450); }
      }
    } });
    return () => { if (t) window.clearTimeout(t); unsub(); };
  }, [activeId]);

  // While a run is active, refresh the preview periodically so the design appears
  // to build live (the agent writes design/index.html incrementally).
  React.useEffect(() => {
    if (!running) return;
    const iv = window.setInterval(() => setNonce(n => n + 1), 3500);
    return () => window.clearInterval(iv);
  }, [running]);

  // Keep the full-screen toggle's icon in sync with the browser's actual state
  // (Esc exits full-screen without going through our button).
  React.useEffect(() => {
    const onFs = () => setFsActive(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const createDesign = async (presetName?: string) => {
    const name = (presetName || newName).trim() || `Design ${designProjects.length + 1}`;
    try {
      const p = await api.createProject({ name, kind: 'design', template: 'design', color: 'purple' });
      setProjects(ps => [...ps, p]); setActiveId(p.id); setSessionId(null); setCreating(false); setNewName('');
    } catch { /* surfaced by the empty state */ }
  };
  const removeSession = async (id: string) => {
    setSessions(ss => ss.filter(x => x.id !== id));
    setSessionId(cur => cur === id ? null : cur);
    try { await api.deleteSession(id); } catch { /* optimistic */ }
  };
  const commitRename = async (id: string) => {
    const t = renameVal.trim(); setRenamingId(null);
    if (!t) return;
    setSessions(ss => ss.map(x => x.id === id ? { ...x, title: t } : x));
    try { await api.renameSession(id, t); } catch { /* optimistic */ }
  };
  // Hand off to code: COPY the design into a new coding project, then seed the
  // first coding turn with the chosen stack + a reference to design/index.html.
  const createCodingFromDesign = async () => {
    if (!active || handingOff) return;
    setHandingOff(true);
    try {
      const proj = await api.copyDesignToCode(active.id, `${active.name} (code)`);
      const fw = FRAMEWORK_LABEL[stack.framework] || stack.framework;
      const lang = stack.framework === 'html' ? '' : (stack.lang === 'ts' ? 'TypeScript' : 'JavaScript');
      const styling = stack.styling === 'tailwind' ? 'Tailwind CSS' : stack.styling === 'css-modules' ? 'CSS Modules' : 'plain CSS';
      const prompt =
        `Turn the existing design into a production-ready ${fw} app${lang ? ` using ${lang}` : ''} and ${styling}${stack.framework !== 'html' ? ` (package manager: ${stack.pkg})` : ''}.\n\n` +
        `The reference design is a self-contained artifact at \`design/index.html\` with its assets under \`design/\` (images, fonts, etc.). It is your source of truth for layout, type scale, spacing, colour and components.\n\n` +
        `Do this in order:\n` +
        `1. Read \`design/index.html\` first and list the sections/components you'll build.\n` +
        `2. Scaffold the ${fw} project here in this folder, wiring up tooling.\n` +
        `3. Faithfully translate the design into real components — match the visuals closely.\n` +
        `4. Keep \`design/index.html\` in place as the visual reference; do NOT delete it.` +
        (stack.notes.trim() ? `\n\nAdditional requirements: ${stack.notes.trim()}` : '');
      const resp = await api.sendChat({ projectId: proj.id, text: prompt });
      setHandoff(false);
      navigate('/workspace', { state: { seedProjectId: proj.id, seedSessionId: resp.session.id, expand: true } });
    } catch { /* error surfaces in the new project's chat once opened */ }
    setHandingOff(false);
  };
  const doSnapshot = async () => {
    if (!active) return;
    setSnap('Saving snapshot…');
    try { const r = await api.snapshotProject(active.id, 'Design snapshot'); setSnap(r.ok ? `Snapshot saved · ${r.hash}` : (r.reason || 'snapshot failed')); }
    catch { setSnap('snapshot failed'); }
    window.setTimeout(() => setSnap(null), 4000);
  };
  const toggleFullscreen = () => {
    const el = previewRef.current; if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  };
  // Drag the splitter to resize the chat panel; persist the final width.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = chatW; let latest = startW;
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => { latest = Math.max(320, Math.min(900, startW + (ev.clientX - startX))); setChatW(latest); };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      setDragging(false);
      try { localStorage.setItem('maestro.design.chatW', String(latest)); } catch { /* storage unavailable */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ── Commenting ───────────────────────────────────────────────────────────
  const postToPreview = (msg: Record<string, unknown>) => {
    try { iframeRef.current?.contentWindow?.postMessage({ __maestro: true, ...msg }, '*'); } catch { /* iframe gone */ }
  };
  const markerItems = React.useCallback((list: DesignComment[]) =>
    list.map((c, i) => ({ selector: c.selector, n: i + 1, status: c.status })), []);
  // Re-sync mode + pins into the (possibly freshly-reloaded) preview.
  const syncPreview = React.useCallback(() => {
    postToPreview({ type: 'comment-markers', items: markerItems(commentsRef.current) });
    postToPreview({ type: 'comment-mode', on: commentModeRef.current });
  }, [markerItems]);

  // Load this design's comments whenever the active project changes.
  React.useEffect(() => {
    setComments([]); setShowComments(false); setCommentMode(false); setPick(null);
    if (!activeId) return;
    let on = true;
    api.listDesignComments(activeId).then(r => { if (on) setComments(r.comments ?? []); }).catch(() => {});
    return () => { on = false; };
  }, [activeId]);

  // Push markers/mode into the preview whenever they change.
  React.useEffect(() => { syncPreview(); }, [comments, commentMode, nonce, syncPreview]);

  // Receive element picks (and Esc-cancel) from the injected harness.
  React.useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { __maestroDesign?: boolean; type?: string; selector?: string; label?: string } | null;
      if (!d || !d.__maestroDesign) return;
      if (d.type === 'comment-pick' && d.selector) { setPick({ selector: d.selector, label: d.label || d.selector }); setNoteText(''); }
      else if (d.type === 'comment-cancel') { setCommentMode(false); }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const toggleCommentMode = () => {
    const next = !commentMode;
    setCommentMode(next);
    if (next) setShowComments(true); else setPick(null);
    postToPreview({ type: 'comment-mode', on: next });
  };
  const savePick = async () => {
    if (!active || !pick) return;
    const note = noteText.trim(); if (!note) return;
    try {
      const r = await api.addDesignComment(active.id, { selector: pick.selector, label: pick.label, note });
      setComments(cs => [...cs, r.comment]);
    } catch { /* surfaced by absence */ }
    setPick(null); setNoteText('');
  };
  const flashComment = (c: DesignComment) => postToPreview({ type: 'flash', selector: c.selector });
  const resolveComment = async (c: DesignComment) => {
    if (!active) return;
    const status = c.status === 'resolved' ? 'open' : 'resolved';
    setComments(cs => cs.map(x => x.id === c.id ? { ...x, status } : x));
    try { await api.setDesignCommentStatus(active.id, c.id, status); } catch { /* optimistic */ }
  };
  const deleteComment = async (c: DesignComment) => {
    if (!active) return;
    setComments(cs => cs.filter(x => x.id !== c.id));
    try { await api.deleteDesignComment(active.id, c.id); } catch { /* optimistic */ }
  };
  const openComments = comments.filter(c => c.status === 'open');
  const sendCommentsToAgent = async () => {
    if (!active || !openComments.length || sending) return;
    setSending(true);
    const prompt = `I've left ${openComments.length} comment(s) on specific elements of the live design. Please revise design/index.html to address each one, keeping everything else intact, then briefly confirm what you changed.\n\n`
      + openComments.map((c, i) => `${i + 1}. Element \`${c.selector}\` (${c.label})\n   Requested change: ${c.note}`).join('\n\n');
    try {
      const resp = await api.sendChat({ projectId: active.id, text: prompt, sessionId: sessionId ?? undefined });
      if (resp.session.id !== sessionId) {
        setSessions(ss => ss.some(x => x.id === resp.session.id) ? ss : [resp.session, ...ss]);
        setSessionId(resp.session.id);
      }
      setCommentMode(false); postToPreview({ type: 'comment-mode', on: false });
    } catch { /* the chat surfaces send errors */ }
    setSending(false);
  };

  const previewUrl = active ? `maestro-design://${active.id}/design/index.html?t=${nonce}` : '';
  const dev = DEVICES.find(d => d.key === device) ?? DEVICES[0];

  return (
    <AppShell active="design" onSearch={() => {}}>
      <style>{DS_SCROLL_CSS}</style>
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
            {/* left: the design conversation — resizable, with a session switcher */}
            <div style={{ width: chatW, minWidth: 320, maxWidth: 900, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {/* session strip — one design project, many conversations (like the CodeSpace) */}
              <div className="ds-scroll" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '0.5px solid var(--separator)', overflowX: 'auto', background: 'var(--bg-grouped)' }}>
                <button onClick={() => setSessionId(null)} title="New chat about this design" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 11px', borderRadius: 'var(--r-pill)', border: '1px dashed var(--separator-strong, var(--separator))', background: sessionId === null ? 'var(--blue)' : 'transparent', color: sessionId === null ? '#fff' : 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>
                  <Icon name="plus" size={13} /> New
                </button>
                {sessions.map(s => {
                  const on = s.id === sessionId;
                  if (renamingId === s.id) return (
                    <input key={s.id} autoFocus value={renameVal} onChange={e => setRenameVal(e.target.value)}
                      onBlur={() => void commitRename(s.id)} onKeyDown={e => { if (e.key === 'Enter') void commitRename(s.id); if (e.key === 'Escape') setRenamingId(null); }}
                      style={{ flexShrink: 0, width: 132, height: 28, padding: '0 9px', borderRadius: 'var(--r-pill)', border: '1px solid var(--blue)', background: 'var(--bg)', color: 'var(--ink)', font: '500 var(--fs-caption)/1 var(--font-text)', outline: 'none' }} />
                  );
                  return (
                    <div key={s.id} className="ds-sess" onClick={() => setSessionId(s.id)} onDoubleClick={() => { setRenamingId(s.id); setRenameVal(s.title); }}
                      title={`${s.title || 'Untitled'} — double-click to rename`} style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 6px 0 11px', borderRadius: 'var(--r-pill)', maxWidth: 190, cursor: 'pointer',
                        background: on ? 'var(--blue)' : 'var(--surface)', border: on ? 'none' : '0.5px solid var(--separator)', color: on ? '#fff' : 'var(--ink)' }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `${on ? 600 : 500} var(--fs-caption)/1 var(--font-text)` }}>{s.title || 'Untitled'}</span>
                      <span style={{ flexShrink: 0, font: '500 9px/1 var(--font-mono)', color: on ? 'rgba(255,255,255,.7)' : 'var(--ink-tertiary)' }}>{relTime(s.updatedAt)}</span>
                      <button className="ds-sess-x" onClick={e => { e.stopPropagation(); void removeSession(s.id); }} title="Delete chat"
                        style={{ flexShrink: 0, width: 16, height: 16, borderRadius: 5, display: 'grid', placeItems: 'center', background: 'transparent', border: 'none', color: on ? 'rgba(255,255,255,.85)' : 'var(--ink-tertiary)', cursor: 'pointer' }}><Icon name="x" size={11} /></button>
                    </div>
                  );
                })}
              </div>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ChatThread key={active.id + ':' + (sessionId ?? 'new')} flush autoFocus projectId={active.id} project={active}
                  sessionId={sessionId} onSessionCreated={(s) => { setSessions(ss => ss.some(x => x.id === s.id) ? ss : [s, ...ss]); setSessionId(s.id); }}
                  onTurns={() => {}}
                  onOpenImage={(assetId, name, imagePath) => setModalImg({ assetId, name, imagePath })} />
              </div>
            </div>

            {/* draggable splitter */}
            <div onMouseDown={startResize} title="Drag to resize" className={`ds-splitter${dragging ? ' dragging' : ''}`}
              style={{ width: 6, flexShrink: 0, cursor: 'col-resize', borderRight: '0.5px solid var(--separator)', background: 'transparent' }} />

            {/* right: live preview (the full-screen target) */}
            <div ref={previewRef} style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-elevated)' }}>
              <div style={{ height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '0.5px solid var(--separator)' }}>
                <div style={{ display: 'flex', gap: 2, background: 'var(--fill-tertiary)', borderRadius: 8, padding: 2 }}>
                  {DEVICES.map(d => (
                    <button key={d.key} onClick={() => setDevice(d.key)} title={d.label} style={{ width: 30, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', background: device === d.key ? 'var(--bg-elevated)' : 'transparent', color: device === d.key ? 'var(--ink)' : 'var(--ink-tertiary)', cursor: 'pointer' }}>
                      <Icon name={d.icon} size={d.key === 'phone' ? 13 : d.key === 'tablet' ? 15 : 16} />
                    </button>
                  ))}
                </div>
                {commentMode
                  ? <span style={{ display: 'flex', alignItems: 'center', gap: 6, font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--orange, #fb8500)' }}><Icon name="target" size={13} /> Click an element to comment</span>
                  : running && <span style={{ display: 'flex', alignItems: 'center', gap: 6, font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--blue)' }}><span className="ds-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--blue)' }} /> Building…</span>}
                {snap && <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: snap.includes('failed') ? 'var(--red, #e5484d)' : 'var(--green)' }}>{snap}</span>}
                <span style={{ flex: 1 }} />
                <button onClick={toggleCommentMode} title={commentMode ? 'Stop commenting' : 'Comment on a specific element'} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', background: commentMode ? 'var(--orange, #fb8500)' : 'transparent', color: commentMode ? '#fff' : 'var(--ink-secondary)' }}><Icon name="chat" size={16} /></button>
                <button onClick={() => setShowComments(s => !s)} title="Comments" className="tb-icon" style={{ position: 'relative', width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', background: showComments ? 'var(--fill-tertiary)' : 'transparent', color: 'var(--ink-secondary)' }}>
                  <Icon name="layers" size={16} />
                  {comments.length > 0 && <span style={{ position: 'absolute', top: -2, right: -2, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, background: openComments.length ? 'var(--orange, #fb8500)' : 'var(--green)', color: '#fff', font: '700 9px/15px var(--font-text)', textAlign: 'center' }}>{comments.length}</span>}
                </button>
                <button onClick={() => setNonce(n => n + 1)} title="Reload preview" className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="refresh" size={16} /></button>
                <button onClick={toggleFullscreen} title={fsActive ? 'Exit full screen' : 'Full screen'} className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: fsActive ? 'var(--blue)' : 'var(--ink-secondary)' }}><Icon name={fsActive ? 'minimize' : 'maximize'} size={16} /></button>
                <button onClick={() => void doSnapshot()} title="Save a referable snapshot (commit the design + attachments)" className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="bookmark" size={16} /></button>
                {IS_LOCAL && active.path && <button onClick={() => void api.revealPath(active.path!)} title="Reveal design folder" className="tb-icon" style={{ width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)' }}><Icon name="folder" size={16} /></button>}
                <button onClick={() => setHandoff(true)} title="Hand off to code — copy this design into a coding project" style={{ display: 'flex', alignItems: 'center', gap: 7, height: 32, padding: '0 12px', borderRadius: 8, background: 'var(--ink)', color: 'var(--bg)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>
                  <Icon name="terminal" size={14} /> Hand off to code
                </button>
              </div>
              <div className="ds-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: dev.w ? 'start center' : 'stretch', padding: dev.w ? 20 : 0, background: dev.w ? 'var(--fill-tertiary)' : 'transparent' }}>
                <iframe ref={iframeRef} key={previewUrl} title="Design preview" src={previewUrl} onLoad={syncPreview}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  style={{ width: dev.w ? Math.min(dev.w, 1400) : '100%', height: '100%', minHeight: dev.w ? 700 : '100%', border: dev.w ? '0.5px solid var(--separator)' : 'none', borderRadius: dev.w ? 12 : 0, background: '#fff', boxShadow: dev.w ? 'var(--card-shadow)' : 'none' }} />
              </div>

              {/* note composer — appears when an element is picked in comment mode */}
              {pick && (
                <div style={{ position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)', width: 'min(460px, calc(100% - 32px))', zIndex: 40, padding: 12, borderRadius: 14, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: '0 16px 50px rgba(0,0,0,0.35)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50% 50% 50% 0', background: 'var(--orange, #fb8500)', transform: 'rotate(45deg)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-caption)/1.3 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pick.label}</span>
                    <button onClick={() => setPick(null)} className="tb-icon" style={{ width: 24, height: 24, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}><Icon name="x" size={13} /></button>
                  </div>
                  <textarea autoFocus value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="What should change here?"
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void savePick(); } if (e.key === 'Escape') setPick(null); }}
                    style={{ width: '100%', minHeight: 56, resize: 'vertical', padding: '8px 10px', borderRadius: 9, border: '1px solid var(--separator)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1.45 var(--font-text)', outline: 'none', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
                    <button onClick={() => setPick(null)} style={{ height: 30, padding: '0 12px', borderRadius: 8, background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>Cancel</button>
                    <button onClick={() => void savePick()} disabled={!noteText.trim()} style={{ height: 30, padding: '0 14px', borderRadius: 8, background: noteText.trim() ? 'var(--blue)' : 'var(--fill-secondary)', color: '#fff', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: noteText.trim() ? 'pointer' : 'default' }}>Add comment</button>
                  </div>
                </div>
              )}

              {/* comments panel — drawer over the preview's right edge */}
              {showComments && (
                <div style={{ position: 'absolute', top: 46, right: 0, bottom: 0, width: 300, zIndex: 30, display: 'flex', flexDirection: 'column', background: 'var(--bg-grouped)', borderLeft: '0.5px solid var(--separator)', boxShadow: '-12px 0 30px rgba(0,0,0,0.12)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '0.5px solid var(--separator)' }}>
                    <span style={{ font: '700 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Comments</span>
                    <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{openComments.length} open · {comments.length - openComments.length} resolved</span>
                    <span style={{ flex: 1 }} />
                    <button onClick={() => setShowComments(false)} className="tb-icon" style={{ width: 26, height: 26, borderRadius: 6, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}><Icon name="x" size={14} /></button>
                  </div>
                  <div className="ds-scroll" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10 }}>
                    {comments.length === 0 ? (
                      <div style={{ padding: '28px 14px', textAlign: 'center', font: '400 var(--fs-caption)/1.6 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                        <Icon name="chat" size={20} style={{ color: 'var(--ink-quaternary, var(--ink-tertiary))', marginBottom: 8 }} />
                        <div>No comments yet. Hit <b>Comment</b>, then click any element in the preview to pin a note for the agent.</div>
                      </div>
                    ) : comments.map((c, i) => (
                      <div key={c.id} style={{ display: 'flex', gap: 9, padding: '9px 8px', borderRadius: 10, marginBottom: 4, background: 'var(--surface)', border: '0.5px solid var(--separator)', opacity: c.status === 'resolved' ? 0.6 : 1 }}>
                        <button onClick={() => flashComment(c)} title="Find in preview" style={{ flexShrink: 0, width: 20, height: 20, borderRadius: '50% 50% 50% 0', transform: 'rotate(45deg)', background: c.status === 'resolved' ? 'var(--green)' : 'var(--orange, #fb8500)', cursor: 'pointer', border: 'none' }}>
                          <span style={{ display: 'block', transform: 'rotate(-45deg)', color: '#fff', font: '700 10px/20px var(--font-text)', textAlign: 'center' }}>{i + 1}</span>
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ font: '600 var(--fs-caption)/1.3 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.label}</div>
                          <div style={{ font: `400 var(--fs-footnote)/1.4 var(--font-text)`, color: 'var(--ink)', marginTop: 2, textDecoration: c.status === 'resolved' ? 'line-through' : 'none' }}>{c.note}</div>
                          <div style={{ display: 'flex', gap: 12, marginTop: 5 }}>
                            <button onClick={() => void resolveComment(c)} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: c.status === 'resolved' ? 'var(--ink-tertiary)' : 'var(--green)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>{c.status === 'resolved' ? 'Reopen' : 'Resolve'}</button>
                            <button onClick={() => void deleteComment(c)} style={{ font: '600 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Delete</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ padding: 10, borderTop: '0.5px solid var(--separator)' }}>
                    <button onClick={() => void sendCommentsToAgent()} disabled={!openComments.length || sending}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, width: '100%', height: 36, borderRadius: 9, border: 'none', background: openComments.length && !sending ? 'var(--blue)' : 'var(--fill-secondary)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: openComments.length && !sending ? 'pointer' : 'default' }}>
                      <Icon name="spark" size={14} /> {sending ? 'Sending…' : `Address ${openComments.length} comment${openComments.length === 1 ? '' : 's'} with the agent`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* generated-image modal — this surface has no tab system, so chat image
          chips open here in place */}
      {modalImg && (
        <div onClick={() => setModalImg(null)} style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: '5vh 5vw' }}>
          <div onClick={e => e.stopPropagation()} style={{ position: 'relative', width: 'min(1100px, 92vw)', height: 'min(86vh, 900px)', display: 'flex', flexDirection: 'column', borderRadius: 16, overflow: 'hidden', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: '0 24px 80px rgba(0,0,0,0.45)' }}>
            <ImageViewer assetId={modalImg.assetId} name={modalImg.name} imagePath={modalImg.imagePath} />
            <button onClick={() => setModalImg(null)} title="Close" className="tb-icon" style={{ position: 'absolute', top: 8, right: 8, width: 32, height: 32, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', color: 'var(--ink-secondary)', cursor: 'pointer' }}><Icon name="x" size={16} /></button>
          </div>
        </div>
      )}

      {/* hand-off-to-code sheet — copies the design into a coding project + asks the stack */}
      {handoff && active && (
        <div onClick={() => !handingOff && setHandoff(false)} style={{ position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', display: 'grid', placeItems: 'center', padding: '5vh 5vw' }}>
          <div onClick={e => e.stopPropagation()} className="ds-scroll" style={{ width: 'min(520px, 94vw)', maxHeight: '90vh', overflow: 'auto', display: 'flex', flexDirection: 'column', borderRadius: 18, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: '0 24px 80px rgba(0,0,0,0.45)' }}>
            <div style={{ padding: '18px 20px 4px', display: 'flex', alignItems: 'flex-start', gap: 11 }}>
              <div style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 9, background: 'var(--ink)', display: 'grid', placeItems: 'center' }}><Icon name="terminal" size={15} style={{ color: 'var(--bg)' }} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: '700 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>Turn this design into code</div>
                <div style={{ font: '400 var(--fs-caption)/1.45 var(--font-text)', color: 'var(--ink-secondary)', marginTop: 2 }}>Copies <b>{active.name}</b> into a new coding project in the CodeSpace — the design stays here too, as the visual reference.</div>
              </div>
            </div>
            <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <HoField label="Framework">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {FRAMEWORKS.map(f => {
                    const on = stack.framework === f.key;
                    return (
                      <button key={f.key} onClick={() => setStack(s => ({ ...s, framework: f.key }))} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, height: 46, padding: '0 12px', borderRadius: 10, border: on ? 'none' : '0.5px solid var(--separator)', background: on ? 'var(--blue)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink)', cursor: 'pointer', justifyContent: 'center' }}>
                        <span style={{ font: '600 var(--fs-footnote)/1 var(--font-text)' }}>{f.label}</span>
                        <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: on ? 'rgba(255,255,255,.78)' : 'var(--ink-tertiary)' }}>{f.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </HoField>
              {stack.framework !== 'html' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <HoField label="Language"><HoSeg opts={LANGS} val={stack.lang} onPick={k => setStack(s => ({ ...s, lang: k }))} /></HoField>
                  <HoField label="Package manager"><HoSeg opts={PKGS} val={stack.pkg} onPick={k => setStack(s => ({ ...s, pkg: k }))} /></HoField>
                </div>
              )}
              <HoField label="Styling"><HoSeg opts={STYLINGS} val={stack.styling} onPick={k => setStack(s => ({ ...s, styling: k }))} /></HoField>
              <HoField label="Anything else to build? (optional)">
                <textarea value={stack.notes} onChange={e => setStack(s => ({ ...s, notes: e.target.value }))} placeholder="Routes, interactions, libraries, API wiring…"
                  style={{ width: '100%', minHeight: 60, resize: 'vertical', padding: '9px 11px', borderRadius: 10, border: '1px solid var(--separator)', background: 'var(--bg)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1.45 var(--font-text)', outline: 'none', boxSizing: 'border-box' }} />
              </HoField>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '6px 20px 18px' }}>
              <button onClick={() => setHandoff(false)} disabled={handingOff} style={{ height: 36, padding: '0 16px', borderRadius: 10, background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => void createCodingFromDesign()} disabled={handingOff} style={{ display: 'flex', alignItems: 'center', gap: 7, height: 36, padding: '0 16px', borderRadius: 10, border: 'none', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: handingOff ? 'default' : 'pointer', opacity: handingOff ? 0.7 : 1 }}>
                <Icon name="terminal" size={14} /> {handingOff ? 'Copying & starting…' : 'Create coding project & start'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
