/* Workspace — the unified coding view. One place to reach every project and
   every chat: a left tree (pinned chats across projects + projects → their
   chats) and a tab bar of open chats you can keep open across projects, like a
   real desktop coding app. The chat itself is the shared <ChatThread>. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../lib/icons';
import { AppShell } from '../lib/appShell';
import { api, IS_LOCAL, type Project, type ChatSession, type ProjectKind, type Job } from '../lib/api';
import { ChatThread } from './ProjectDetail';
import { FileViewer, ImageViewer } from '../lib/CodeView';
import { BrowserPane } from '../lib/BrowserPane';
import { RightSidebar, type CheckItem } from '../lib/RightSidebar';
import { IS_WRITE_TOOL } from '../lib/fileChip';
import type { IconName } from '../lib/icons';

const PAGE_CSS = `
  .ws-row { transition: background 120ms ease; }
  .ws-row:hover { background: var(--fill-tertiary); }
  .ws-row .ws-act { opacity: 0; transition: opacity 120ms ease; }
  .ws-row:hover .ws-act, .ws-row.ws-active .ws-act { opacity: 1; }
  .ws-tab { transition: background 120ms ease, color 120ms ease; }
  .ws-tab:hover { background: var(--fill-tertiary); }
  .ws-tab .ws-tab-x { opacity: 0; transition: opacity 120ms ease; }
  .ws-tab:hover .ws-tab-x, .ws-tab.on .ws-tab-x { opacity: 1; }
  .ws-newbtn:hover { background: var(--fill-secondary) !important; }
  .ws-tabs::-webkit-scrollbar { height: 0; }
  .ws-kinds::-webkit-scrollbar { height: 0; }
  .ws-tree::-webkit-scrollbar { width: 11px; }
  .ws-tree::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ink) 22%, transparent); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
  .ws-tree:hover::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--ink) 40%, transparent); background-clip: padding-box; }
  .ws-proj:hover .ws-newchat { opacity: 1; }
  .ws-newchat { opacity: 0; transition: opacity 120ms ease; }
  /* project header sticks to the top of the scroll area while you read its
     chats, so the project you're in (and its collapse/new-chat controls) is
     always reachable in a long list */
  .ws-proj-head { position: sticky; top: 0; z-index: 2; background: var(--bg-grouped); }
  /* overflow menu of open tabs — so every open chat is one click away even
     when the tab strip is scrolled past the edge */
  .ws-ovf-item:hover { background: var(--fill-tertiary); }
`;

interface Tab { key: string; projectId: string; sessionId: string | null; title: string; kind?: 'chat' | 'file' | 'image' | 'browser'; filePath?: string; imageAssetId?: string; imagePath?: string }

const TABS_KEY = 'maestro.workspace.tabs';
const EXPANDED_KEY = 'maestro.workspace.expanded';

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}
const projColor = (p?: Project): string => (p?.color ? `var(--${p.color})` : 'var(--blue)');
const projKind = (p?: Project): ProjectKind => (p?.kind ?? 'general');

const KIND_FILTER_KEY = 'maestro.workspace.kind';
type KindFilter = ProjectKind | 'all';
const KIND_META: { key: KindFilter; label: string; icon: IconName; tint: string }[] = [
  { key: 'all', label: 'All', icon: 'layers', tint: 'var(--ink-secondary)' },
  { key: 'coding', label: 'Code', icon: 'terminal', tint: 'var(--blue)' },
  { key: 'content', label: 'Content', icon: 'clapper', tint: 'var(--purple)' },
  { key: 'research', label: 'Research', icon: 'telescope', tint: 'var(--indigo)' },
  { key: 'general', label: 'General', icon: 'command', tint: 'var(--ink-secondary)' },
];
const kindOf = (k: KindFilter) => KIND_META.find(m => m.key === k) ?? KIND_META[0];

export default function Workspace() {
  const navigate = useNavigate();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')); } catch { return new Set(); }
  });
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameVal, setRenameVal] = React.useState('');
  const [kindFilter, setKindFilterState] = React.useState<KindFilter>(() => {
    try { const v = localStorage.getItem(KIND_FILTER_KEY); return (v && KIND_META.some(m => m.key === v)) ? v as KindFilter : 'all'; } catch { return 'all'; }
  });
  const setKindFilter = (k: KindFilter) => { setKindFilterState(k); try { localStorage.setItem(KIND_FILTER_KEY, k); } catch { /* ignore */ } };
  const [query, setQuery] = React.useState('');
  const newCounter = React.useRef(0);
  const restored = React.useRef(false);
  // tab strip: scroll the active tab into view, surface an overflow menu of
  // every open chat when the strip is too narrow to show them all.
  const tabStripRef = React.useRef<HTMLDivElement>(null);
  const [tabsOverflow, setTabsOverflow] = React.useState(false);
  const [ovfOpen, setOvfOpen] = React.useState(false);
  // active chat's turns, lifted from each ChatThread, for the "Changed files" panel
  const [turnsByTab, setTurnsByTab] = React.useState<Record<string, Job[]>>({});
  const [addOpen, setAddOpen] = React.useState(false); // add-project menu
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => { try { return localStorage.getItem('maestro.workspace.sidebar') === '0'; } catch { return false; } });
  const toggleSidebar = () => setSidebarCollapsed(c => { const n = !c; try { localStorage.setItem('maestro.workspace.sidebar', n ? '0' : '1'); } catch { /* ignore */ } return n; });

  const projById = React.useMemo(() => { const m: Record<string, Project> = {}; projects.forEach(p => { m[p.id] = p; }); return m; }, [projects]);

  // initial load: projects + all sessions
  React.useEffect(() => {
    let alive = true;
    Promise.all([api.listProjects(), api.listSessions()])
      .then(([ps, ss]) => { if (alive) { setProjects(ps); setSessions(ss); } })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // restore open tabs once sessions are known
  React.useEffect(() => {
    if (restored.current || sessions.length === 0) return;
    restored.current = true;
    try {
      const saved = JSON.parse(localStorage.getItem(TABS_KEY) || '{}') as { tabs?: { projectId: string; sessionId: string }[]; active?: string };
      const rebuilt: Tab[] = (saved.tabs || [])
        .map((t): Tab | null => { const s = sessions.find(x => x.id === t.sessionId); return s ? { key: s.id, projectId: s.projectId, sessionId: s.id, title: s.title } : null; })
        .filter((t): t is Tab => !!t);
      if (rebuilt.length) { setTabs(rebuilt); setActiveKey(rebuilt.find(t => t.key === saved.active)?.key ?? rebuilt[0].key); }
    } catch { /* ignore */ }
  }, [sessions]);

  // persist tabs (only the session-backed ones survive a relaunch)
  React.useEffect(() => {
    try {
      const payload = { tabs: tabs.filter(t => t.sessionId).map(t => ({ projectId: t.projectId, sessionId: t.sessionId })), active: activeKey };
      localStorage.setItem(TABS_KEY, JSON.stringify(payload));
    } catch { /* ignore */ }
  }, [tabs, activeKey]);

  React.useEffect(() => { try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch { /* ignore */ } }, [expanded]);

  // LIVE: keep the tree + tab titles current.
  React.useEffect(() => {
    const unsub = api.subscribe({
      onSession: (s) => {
        if ((s as { deleted?: boolean }).deleted) {
          setSessions(ss => ss.filter(x => x.id !== s.id));
          setTabs(ts => ts.filter(t => t.sessionId !== s.id));
          return;
        }
        setSessions(ss => { const i = ss.findIndex(x => x.id === s.id); return i === -1 ? [s, ...ss] : ss.map(x => (x.id === s.id ? s : x)); });
        setTabs(ts => ts.map(t => (t.sessionId === s.id ? { ...t, title: s.title } : t)));
      },
      onProject: () => { api.listProjects().then(setProjects).catch(() => {}); },
    });
    return unsub;
  }, []);

  const activeTab = tabs.find(t => t.key === activeKey) ?? null;
  const activeProject = activeTab ? projById[activeTab.projectId] : undefined;

  // Open a file as a tab (deduped on its path).
  const openFile = (projectId: string, filePath: string) => {
    const existing = tabs.find(t => t.kind === 'file' && t.filePath === filePath);
    if (existing) { setActiveKey(existing.key); return; }
    const key = 'file:' + filePath;
    setTabs(ts => (ts.some(t => t.key === key) ? ts : [...ts, { key, projectId, sessionId: null, title: filePath.split('/').pop() ?? filePath, kind: 'file', filePath }]));
    setActiveKey(key);
  };
  // Open a generated/attached image in its own VS Code-style tab (not Finder).
  const openImage = (projectId: string, assetId: string, name: string, imagePath?: string) => {
    const key = 'image:' + assetId;
    const existing = tabs.find(t => t.key === key);
    if (existing) { setActiveKey(existing.key); return; }
    setTabs(ts => (ts.some(t => t.key === key) ? ts : [...ts, { key, projectId, sessionId: null, title: name || 'Image', kind: 'image', imageAssetId: assetId, imagePath }]));
    setActiveKey(key);
  };
  // Open the live Browser tab for a project (one per project; deduped).
  const openBrowser = (projectId: string) => {
    const key = 'browser:' + projectId;
    const existing = tabs.find(t => t.key === key);
    if (existing) { setActiveKey(existing.key); return; }
    setTabs(ts => (ts.some(t => t.key === key) ? ts : [...ts, { key, projectId, sessionId: null, title: 'Browser', kind: 'browser' }]));
    setActiveKey(key);
  };
  // Files the active chat wrote (from its turns' write-tool steps), newest first.
  const changedFiles = React.useMemo(() => {
    const jobs = turnsByTab[activeKey ?? ''] ?? [];
    const rootPath = activeProject?.path;
    const seen = new Set<string>(); const out: string[] = [];
    for (const job of jobs) for (const it of job.transcript ?? []) {
      if (it.kind === 'tool' && IS_WRITE_TOOL(it.name ?? '') && it.text) {
        let p = it.text.trim();
        if (!p.startsWith('/') && rootPath) p = rootPath.replace(/\/$/, '') + '/' + p;
        if (!seen.has(p)) { seen.add(p); out.unshift(p); }
      }
    }
    return out;
  }, [turnsByTab, activeKey, activeProject]);
  // Reviewer verdicts for the active chat → the "Checks" tab.
  const checks = React.useMemo<CheckItem[]>(() => {
    const jobs = turnsByTab[activeKey ?? ''] ?? [];
    const out: CheckItem[] = [];
    for (const job of jobs) for (const it of job.transcript ?? []) {
      if (it.kind === 'review' && it.verdict) out.unshift({ id: `${job.id}-${it.ts}`, title: it.name ? `Reviewer · ${it.name}` : 'Review', verdict: it.verdict, text: it.text });
    }
    return out;
  }, [turnsByTab, activeKey]);

  // Add-project: open a local folder as a coding project (native picker).
  const openLocalFolder = async () => {
    setAddOpen(false);
    try {
      const r = await api.pickFolder();
      if (!r || !r.ok || !r.path) return;
      const name = r.path.split('/').filter(Boolean).pop() ?? 'Project';
      const proj = await api.createProject({ name, kind: 'coding', path: r.path, instructions: '', color: 'blue' });
      setProjects(ps => (ps.some(x => x.id === proj.id) ? ps : [proj, ...ps]));
      setExpanded(e => new Set(e).add(proj.id));
    } catch { /* cancelled or failed */ }
  };
  const recents = projects.filter(p => p.path).slice(0, 5);

  // keep the active tab in view + recompute whether the strip overflows
  React.useLayoutEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const measure = () => setTabsOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const node = activeKey ? el.querySelector(`[data-tabkey="${(window.CSS && CSS.escape) ? CSS.escape(activeKey) : activeKey}"]`) : null;
    (node as HTMLElement | null)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs, activeKey]);

  const openSession = (s: ChatSession) => {
    const existing = tabs.find(t => t.sessionId === s.id);
    if (existing) { setActiveKey(existing.key); return; }
    setTabs(ts => [...ts, { key: s.id, projectId: s.projectId, sessionId: s.id, title: s.title }]);
    setActiveKey(s.id);
  };
  const newChat = (projectId: string) => {
    const key = `new:${newCounter.current++}`;
    setTabs(ts => [...ts, { key, projectId, sessionId: null, title: 'New chat' }]);
    setActiveKey(key);
    if (!expanded.has(projectId)) setExpanded(e => new Set(e).add(projectId));
  };
  const closeTab = (key: string) => {
    setTabs(ts => {
      const idx = ts.findIndex(t => t.key === key);
      const next = ts.filter(t => t.key !== key);
      if (activeKey === key) setActiveKey(next.length ? next[Math.min(idx, next.length - 1)].key : null);
      return next;
    });
  };
  // a new chat's first send created a real session → adopt it into the tab + tree
  const onSessionCreated = (tabKey: string) => (s: ChatSession) => {
    setSessions(ss => (ss.some(x => x.id === s.id) ? ss : [s, ...ss]));
    setTabs(ts => ts.map(t => (t.key === tabKey ? { ...t, sessionId: s.id, title: s.title } : t)));
  };

  const togglePin = (s: ChatSession) => {
    const pinned = !s.pinned;
    setSessions(ss => ss.map(x => (x.id === s.id ? { ...x, pinned } : x)));
    void api.pinSession(s.id, pinned).catch(() => {});
  };
  const deleteSession = (id: string) => {
    void api.deleteSession(id).catch(() => {});
    setSessions(ss => ss.filter(s => s.id !== id));
    setTabs(ts => ts.filter(t => t.sessionId !== id));
  };
  const commitRename = (id: string) => {
    const title = renameVal.trim(); setRenamingId(null);
    if (!title) return;
    setSessions(ss => ss.map(s => (s.id === id ? { ...s, title } : s)));
    setTabs(ts => ts.map(t => (t.sessionId === id ? { ...t, title } : t)));
    void api.renameSession(id, title).catch(() => {});
  };

  // Filtering: by project kind + a fuzzy name search over projects AND chats.
  const q = query.trim().toLowerCase();
  const kindMatch = (p?: Project) => kindFilter === 'all' || projKind(p) === kindFilter;
  const chatHit = (s: ChatSession) => !q || s.title.toLowerCase().includes(q);
  const projHit = (p: Project) => !q || p.name.toLowerCase().includes(q) || sessions.some(s => s.projectId === p.id && s.title.toLowerCase().includes(q));

  const kindCount = (k: KindFilter) => (k === 'all' ? projects.length : projects.filter(p => projKind(p) === k).length);
  const visibleProjects = projects.filter(p => kindMatch(p) && projHit(p));
  const sessionsByProject = (pid: string) => {
    const p = projById[pid];
    return sessions.filter(s => s.projectId === pid && (!q || chatHit(s) || (p && p.name.toLowerCase().includes(q)))).sort((a, b) => b.updatedAt - a.updatedAt);
  };
  const pinned = sessions.filter(s => s.pinned && kindMatch(projById[s.projectId]) && (chatHit(s) || (projById[s.projectId]?.name.toLowerCase().includes(q) ?? false))).sort((a, b) => b.updatedAt - a.updatedAt);

  // a session row in the tree
  const SessionRow = ({ s, indent }: { s: ChatSession; indent: number }) => {
    const open = tabs.some(t => t.sessionId === s.id);
    const isActive = activeTab?.sessionId === s.id;
    const p = projById[s.projectId];
    return (
      <div className={`ws-row${isActive ? ' ws-active' : ''}`} onClick={() => openSession(s)} style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: `5px 8px 5px ${indent}px`, borderRadius: 8, cursor: 'pointer',
        background: isActive ? 'color-mix(in srgb, var(--blue) 11%, transparent)' : 'transparent' }}>
        <span style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: open ? projColor(p) : 'var(--separator-strong)' }} />
        {renamingId === s.id ? (
          <input autoFocus value={renameVal} onClick={e => e.stopPropagation()} onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(s.id)} onKeyDown={e => { if (e.key === 'Enter') commitRename(s.id); if (e.key === 'Escape') setRenamingId(null); }}
            style={{ flex: 1, minWidth: 0, border: '1px solid var(--blue)', borderRadius: 6, padding: '1px 5px', background: 'var(--bg)', color: 'var(--ink)', font: '500 var(--fs-footnote)/1.3 var(--font-text)' }} />
        ) : (
          <span onDoubleClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameVal(s.title); }}
            style={{ flex: 1, minWidth: 0, font: `${isActive ? 600 : 500} var(--fs-footnote)/1.35 var(--font-text)`, color: isActive ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {s.title}
          </span>
        )}
        <span className="ws-act" style={{ display: 'inline-flex', gap: 1, flexShrink: 0 }}>
          <button title={s.pinned ? 'Unpin' : 'Pin to top'} onClick={e => { e.stopPropagation(); togglePin(s); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: s.pinned ? 'var(--blue)' : 'var(--ink-tertiary)' }}>
            <Icon name="bookmark" size={12} />
          </button>
          <button title="Delete chat" onClick={e => { e.stopPropagation(); deleteSession(s.id); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
            <Icon name="x" size={12} stroke={2.4} />
          </button>
        </span>
      </div>
    );
  };

  const sectionLabel = (t: string) => (
    <div style={{ padding: '10px 8px 4px', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{t}</div>
  );

  return (
    <AppShell active="workspace">
      <style>{PAGE_CSS}</style>
      <div style={{ height: '100%', display: 'flex', minHeight: 0 }}>
        {/* ── left tree: pinned + projects → chats ── */}
        <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '0.5px solid var(--separator)', background: 'var(--bg-grouped)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 14px 10px' }}>
            <Icon name="terminal" size={16} style={{ color: 'var(--blue)' }} />
            <span style={{ flex: 1, font: '700 var(--fs-callout)/1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>Workspace</span>
            <div style={{ position: 'relative' }}>
              <button onClick={() => setAddOpen(o => !o)} title="Add a project" className="ws-newbtn" style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'transparent', color: addOpen ? 'var(--ink)' : 'var(--ink-tertiary)' }}>
                <Icon name="plus" size={16} stroke={2.4} />
              </button>
              {addOpen && (
                <>
                  <div onClick={() => setAddOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 41, marginTop: 4, width: 232, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 12, boxShadow: 'var(--shadow-lg, 0 18px 50px rgba(15,20,60,0.24))', padding: 5 }}>
                    {([
                      { icon: 'folder', label: 'Open project', sub: 'A local folder on this Mac', act: openLocalFolder },
                      { icon: 'terminal', label: 'Open GitHub project', sub: 'Clone a repository', act: () => { setAddOpen(false); navigate('/projects'); } },
                      { icon: 'plus', label: 'New project', sub: 'Start from scratch', act: () => { setAddOpen(false); navigate('/projects'); } },
                    ] as { icon: IconName; label: string; sub: string; act: () => void }[]).map(it => (
                      <button key={it.label} onClick={it.act} className="ws-ovf-item" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '8px 9px', borderRadius: 8, cursor: 'pointer' }}>
                        <Icon name={it.icon} size={15} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', font: '600 var(--fs-footnote)/1.1 var(--font-text)', color: 'var(--ink)' }}>{it.label}</span>
                          <span style={{ display: 'block', font: '400 var(--fs-caption)/1.2 var(--font-text)', color: 'var(--ink-tertiary)', marginTop: 1 }}>{it.sub}</span>
                        </span>
                      </button>
                    ))}
                    {recents.length > 0 && (
                      <div style={{ borderTop: '0.5px solid var(--separator)', margin: '5px 0 0', paddingTop: 5 }}>
                        <div style={{ padding: '2px 9px 4px', font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>Recents</div>
                        {recents.map(p => (
                          <button key={p.id} onClick={() => { setAddOpen(false); setExpanded(e => new Set(e).add(p.id)); }} className="ws-ovf-item" title={p.path} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 9px', borderRadius: 8, cursor: 'pointer' }}>
                            <span style={{ width: 7, height: 7, borderRadius: 3, flexShrink: 0, background: projColor(p) }} />
                            <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* search + kind filter — narrow to a type, or find a project/chat by name */}
          {projects.length > 0 && (
            <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 32, padding: '0 10px', borderRadius: 9, background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)' }}>
                <Icon name="search" size={14} style={{ color: 'var(--ink-tertiary)', flexShrink: 0 }} />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter projects & chats…"
                  style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', font: '400 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }} />
                {query && <button onClick={() => setQuery('')} title="Clear" style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}><Icon name="x" size={11} stroke={2.4} /></button>}
              </div>
              {/* single horizontal row — the vertical mouse wheel scrolls it
                  sideways so every category is reachable without wrapping */}
              <div className="ws-kinds" onWheel={e => { const el = e.currentTarget; if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) el.scrollLeft += e.deltaY; }}
                style={{ display: 'flex', gap: 5, overflowX: 'auto', WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 16px), transparent)', maskImage: 'linear-gradient(to right, #000 calc(100% - 16px), transparent)' }}>
                {KIND_META.map(m => {
                  const on = kindFilter === m.key;
                  const n = kindCount(m.key);
                  if (m.key !== 'all' && n === 0) return null;
                  return (
                    <button key={m.key} onClick={() => setKindFilter(m.key)} title={`${m.label} · ${n}`} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 9px', borderRadius: 'var(--r-pill)', flexShrink: 0, cursor: 'pointer',
                      background: on ? `color-mix(in srgb, ${m.tint} 16%, transparent)` : 'var(--fill-secondary)',
                      border: on ? `1px solid color-mix(in srgb, ${m.tint} 45%, transparent)` : '1px solid transparent',
                      color: on ? m.tint : 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>
                      <Icon name={m.icon} size={12} /> {m.label} <span style={{ opacity: 0.7 }}>{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="ws-tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' }}>
            {projects.length === 0 && (
              <div style={{ padding: '40px 14px', textAlign: 'center', font: '400 var(--fs-footnote)/1.55 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                No projects yet.
                <button onClick={() => navigate('/projects')} style={{ display: 'block', margin: '12px auto 0', height: 32, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Create a project</button>
              </div>
            )}

            {pinned.length > 0 && (
              <>
                {sectionLabel('Pinned')}
                {pinned.map(s => <SessionRow key={'p' + s.id} s={s} indent={8} />)}
              </>
            )}

            {visibleProjects.length > 0 && sectionLabel(kindFilter === 'all' ? 'Projects' : `${kindOf(kindFilter).label} projects`)}
            {projects.length > 0 && visibleProjects.length === 0 && (
              <div style={{ padding: '24px 14px', textAlign: 'center', font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                No {kindFilter === 'all' ? '' : kindOf(kindFilter).label.toLowerCase() + ' '}projects{q ? ' match' : ''}.
                {(q || kindFilter !== 'all') && <button onClick={() => { setQuery(''); setKindFilter('all'); }} style={{ display: 'block', margin: '10px auto 0', height: 28, padding: '0 12px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>Clear filters</button>}
              </div>
            )}
            {visibleProjects.map(p => {
              const chats = sessionsByProject(p.id);
              const isOpen = expanded.has(p.id) || (!!q && chats.length > 0);
              return (
                <div key={p.id} className="ws-proj">
                  <div className="ws-row ws-proj-head" onClick={() => setExpanded(e => { const n = new Set(e); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 6px', cursor: 'pointer' }}>
                    <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)', flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 160ms var(--spring)' }} />
                    <span style={{ width: 8, height: 8, borderRadius: 3, flexShrink: 0, background: projColor(p) }} />
                    <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                    {chats.length > 0 && <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{chats.length}</span>}
                    <button className="ws-newchat" title="New chat here" onClick={e => { e.stopPropagation(); newChat(p.id); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--blue)', flexShrink: 0 }}>
                      <Icon name="plus" size={14} stroke={2.4} />
                    </button>
                  </div>
                  {isOpen && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {chats.length === 0 && (
                        <button onClick={() => newChat(p.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 26px', borderRadius: 8, color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1.3 var(--font-text)', cursor: 'pointer' }}>
                          <Icon name="plus" size={12} /> New chat
                        </button>
                      )}
                      {chats.map(s => <SessionRow key={s.id} s={s} indent={26} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── right: tab bar + active chat ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* tab bar */}
          <div style={{ display: 'flex', alignItems: 'stretch', height: 42, flexShrink: 0, borderBottom: '0.5px solid var(--separator)', background: 'var(--bg-grouped)' }}>
            <div ref={tabStripRef} className="ws-tabs"
              onWheel={e => { const el = tabStripRef.current; if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY; }}
              style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}>
              {tabs.map(t => {
                const on = t.key === activeKey;
                const p = projById[t.projectId];
                return (
                  <div key={t.key} data-tabkey={t.key} className={`ws-tab${on ? ' on' : ''}`} onClick={() => setActiveKey(t.key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px 0 13px', maxWidth: 220, flexShrink: 0, cursor: 'pointer', position: 'relative',
                      borderRight: '0.5px solid var(--separator)', background: on ? 'var(--bg-elevated)' : 'transparent' }}>
                    {on && <span style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: projColor(p) }} />}
                    {t.kind === 'file'
                      ? <Icon name="file" size={12} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
                      : t.kind === 'browser'
                      ? <Icon name="globe" size={12} style={{ color: 'var(--blue)', flexShrink: 0 }} />
                      : t.kind === 'image'
                      ? <Icon name="image" size={12} style={{ color: 'var(--purple, #8b5cf6)', flexShrink: 0 }} />
                      : <span style={{ width: 7, height: 7, borderRadius: 3, flexShrink: 0, background: projColor(p) }} />}
                    <span style={{ minWidth: 0, maxWidth: 150, font: `${on ? 600 : 500} var(--fs-footnote)/1 var(--font-text)`, color: on ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                    <button className="ws-tab-x" title="Close tab" onClick={e => { e.stopPropagation(); closeTab(t.key); }} style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
                      <Icon name="x" size={11} stroke={2.6} />
                    </button>
                  </div>
                );
              })}
            </div>
            {tabsOverflow && tabs.length > 0 && (
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <button onClick={() => setOvfOpen(o => !o)} title="All open chats" className="ws-newbtn"
                  style={{ width: 34, height: '100%', display: 'grid', placeItems: 'center', borderLeft: '0.5px solid var(--separator)', color: ovfOpen ? 'var(--ink)' : 'var(--ink-secondary)', background: 'transparent', cursor: 'pointer' }}>
                  <Icon name="chevronDown" size={15} />
                </button>
                {ovfOpen && (
                  <>
                    <div onClick={() => setOvfOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                    <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 41, marginTop: 4, minWidth: 230, maxHeight: 340, overflowY: 'auto', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 12, boxShadow: 'var(--card-shadow)', padding: 5 }}>
                      {tabs.map(t => {
                        const on = t.key === activeKey;
                        const p = projById[t.projectId];
                        return (
                          <div key={t.key} className="ws-ovf-item" onClick={() => { setActiveKey(t.key); setOvfOpen(false); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 8, cursor: 'pointer', background: on ? 'color-mix(in srgb, var(--blue) 11%, transparent)' : 'transparent' }}>
                            <span style={{ width: 7, height: 7, borderRadius: 3, flexShrink: 0, background: projColor(p) }} />
                            <span style={{ flex: 1, minWidth: 0, font: `${on ? 600 : 500} var(--fs-footnote)/1.25 var(--font-text)`, color: on ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                            {p && <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0, maxWidth: 70, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>}
                            <button title="Close tab" onClick={e => { e.stopPropagation(); closeTab(t.key); }} style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
                              <Icon name="x" size={11} stroke={2.4} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
            {IS_LOCAL && (
              <button onClick={() => openBrowser(activeTab?.projectId ?? projects[0]?.id ?? '')} disabled={projects.length === 0}
                title="Open the live browser for this project" className="ws-newbtn" style={{ width: 38, flexShrink: 0, display: 'grid', placeItems: 'center', borderLeft: '0.5px solid var(--separator)', color: 'var(--ink-secondary)', background: 'transparent', cursor: projects.length ? 'pointer' : 'default' }}>
                <Icon name="globe" size={15} />
              </button>
            )}
            <button onClick={() => newChat(activeTab?.projectId ?? projects[0]?.id ?? '')} disabled={projects.length === 0}
              title="New chat" className="ws-newbtn" style={{ width: 40, flexShrink: 0, display: 'grid', placeItems: 'center', borderLeft: '0.5px solid var(--separator)', color: 'var(--ink-secondary)', background: 'transparent', cursor: projects.length ? 'pointer' : 'default' }}>
              <Icon name="plus" size={16} stroke={2.4} />
            </button>
          </div>

          {/* panes (chat or file — all kept mounted) + the right-side files panel */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ flex: 1, minWidth: 340, position: 'relative', display: 'flex' }}>
              {tabs.length === 0 && (
                <div style={{ flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 40 }}>
                  <div>
                    <span style={{ width: 60, height: 60, borderRadius: 18, display: 'inline-grid', placeItems: 'center', marginBottom: 16,
                      background: 'linear-gradient(160deg, color-mix(in srgb, var(--blue) 16%, transparent), color-mix(in srgb, var(--purple) 14%, transparent))', color: 'var(--blue)' }}>
                      <Icon name="terminal" size={28} />
                    </span>
                    <div style={{ font: '700 var(--fs-title2)/1.2 var(--font-display)', color: 'var(--ink)', marginBottom: 6 }}>Open a chat to start coding</div>
                    <div style={{ font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)', maxWidth: 380 }}>
                      Pick a project on the left and start a chat — keep several open as tabs and jump between them.
                    </div>
                  </div>
                </div>
              )}
              {tabs.map(t => (
                <div key={t.key} style={{ position: 'absolute', inset: 0, display: t.key === activeKey ? 'flex' : 'none' }}>
                  {t.kind === 'file' && t.filePath
                    ? <FileViewer projectId={t.projectId} filePath={t.filePath} />
                    : t.kind === 'image'
                    ? <ImageViewer assetId={t.imageAssetId} name={t.title} imagePath={t.imagePath} />
                    : t.kind === 'browser'
                    ? <BrowserPane projectId={t.projectId} />
                    : <ChatThread flush autoFocus={t.key === activeKey} projectId={t.projectId} project={projById[t.projectId] ?? null}
                        sessionId={t.sessionId} onSessionCreated={onSessionCreated(t.key)} onTurns={js => setTurnsByTab(m => ({ ...m, [t.key]: js }))}
                        onOpenImage={(assetId, name, imagePath) => openImage(t.projectId, assetId, name, imagePath)} />}
                </div>
              ))}
            </div>
            {IS_LOCAL && activeProject?.path && (
              <RightSidebar project={activeProject} changed={changedFiles} checks={checks}
                onOpenFile={p => openFile(activeProject.id, p)}
                collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar} />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
