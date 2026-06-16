/* Workspace — the unified coding view. One place to reach every project and
   every chat: a left tree (pinned chats across projects + projects → their
   chats) and a tab bar of open chats you can keep open across projects, like a
   real desktop coding app. The chat itself is the shared <ChatThread>. */

import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon } from '../lib/icons';
import { AppShell } from '../lib/appShell';
import { api, IS_LOCAL, type Project, type ChatSession, type ProjectKind, type Job } from '../lib/api';
import { ChatThread } from './ProjectDetail';
import { FileViewer, ImageViewer } from '../lib/CodeView';
import { ProjectPanel } from '../lib/ProjectPanel';
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

type ProjectSection = 'settings' | 'instructions' | 'jobs' | 'skills';
interface Tab { key: string; projectId: string; sessionId: string | null; title: string; kind?: 'chat' | 'file' | 'image' | 'project'; filePath?: string; imageAssetId?: string; imagePath?: string; projectSection?: ProjectSection }

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
const CHAT_PREVIEW = 7; // chats shown per project before "Show all"

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
  const location = useLocation();
  const seedConsumed = React.useRef(false);
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [sessions, setSessions] = React.useState<ChatSession[]>([]);
  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')); } catch { return new Set(); }
  });
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameVal, setRenameVal] = React.useState('');
  // Cap chats shown per project so a busy one doesn't bury the others; "Show all"
  // per project reveals the rest. Searching always shows every match.
  const [chatsAllOpen, setChatsAllOpen] = React.useState<Set<string>>(new Set());
  // Per-project "⋯" menu (settings / jobs / instructions / reveal …).
  const [menuProj, setMenuProj] = React.useState<string | null>(null);
  // Project pending a delete confirmation (the destructive modal).
  const [confirmDelProj, setConfirmDelProj] = React.useState<string | null>(null);
  // Per-project "Archived" sub-list expanded state.
  const [archivedOpen, setArchivedOpen] = React.useState<Set<string>>(new Set());
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

  // Hand-off-from-design: open the freshly-copied coding project + its seeded chat
  // (the design tab navigated here with these ids). One-shot — cleared after use.
  React.useEffect(() => {
    const st = location.state as { seedProjectId?: string; seedSessionId?: string; expand?: boolean } | null;
    if (!st?.seedProjectId || seedConsumed.current) return;
    seedConsumed.current = true;
    const { seedProjectId, seedSessionId } = st;
    api.listProjects().then(setProjects).catch(() => {}); // pick up the new project immediately
    if (st.expand) setExpanded(e => new Set(e).add(seedProjectId));
    if (seedSessionId) {
      setTabs(ts => ts.some(t => t.sessionId === seedSessionId) ? ts : [...ts, { key: seedSessionId, projectId: seedProjectId, sessionId: seedSessionId, title: 'Building from design…' }]);
      setActiveKey(seedSessionId);
    }
    navigate('.', { replace: true, state: {} }); // clear so back/refresh doesn't re-seed
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Open a project hub tab (settings / instructions+memory / jobs) — deduped.
  const openProject = (projectId: string, section: ProjectSection = 'settings') => {
    const key = 'project:' + projectId;
    setTabs(ts => ts.some(t => t.key === key)
      ? ts.map(t => (t.key === key ? { ...t, projectSection: section } : t))
      : [...ts, { key, projectId, sessionId: null, title: projById[projectId]?.name ?? 'Project', kind: 'project', projectSection: section }]);
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
  const recents = projects.filter(p => p.path && projKind(p) !== 'design').slice(0, 5);

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
  const archiveSession = (s: ChatSession, archived: boolean) => {
    setSessions(ss => ss.map(x => (x.id === s.id ? { ...x, archived: archived ? Date.now() : undefined, pinned: archived ? undefined : x.pinned } : x)));
    // Archiving an open chat closes its tab (it's no longer in the active list).
    if (archived) setTabs(ts => ts.filter(t => t.sessionId !== s.id));
    void api.archiveSession(s.id, archived).catch(() => {});
  };
  const deleteProject = (id: string) => {
    setConfirmDelProj(null);
    setProjects(ps => ps.filter(p => p.id !== id));
    setTabs(ts => ts.filter(t => t.projectId !== id));
    setExpanded(e => { const n = new Set(e); n.delete(id); return n; });
    void api.deleteProject(id).catch(() => {});
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

  // CodeSpace shows coding work only — design projects live in the Design tab.
  const codeProjects = projects.filter(p => projKind(p) !== 'design');
  const kindCount = (k: KindFilter) => (k === 'all' ? codeProjects.length : codeProjects.filter(p => projKind(p) === k).length);
  const visibleProjects = codeProjects.filter(p => kindMatch(p) && projHit(p));
  const sessionsByProject = (pid: string) => {
    const p = projById[pid];
    return sessions.filter(s => s.projectId === pid && !s.archived && (!q || chatHit(s) || (p && p.name.toLowerCase().includes(q)))).sort((a, b) => b.updatedAt - a.updatedAt);
  };
  // Archived chats for a project (most-recently-archived first), restorable.
  const archivedByProject = (pid: string) => {
    const p = projById[pid];
    return sessions.filter(s => s.projectId === pid && s.archived && (!q || chatHit(s) || (p && p.name.toLowerCase().includes(q)))).sort((a, b) => (b.archived ?? 0) - (a.archived ?? 0));
  };
  const pinned = sessions.filter(s => s.pinned && !s.archived && projKind(projById[s.projectId]) !== 'design' && kindMatch(projById[s.projectId]) && (chatHit(s) || (projById[s.projectId]?.name.toLowerCase().includes(q) ?? false))).sort((a, b) => b.updatedAt - a.updatedAt);

  // a session row in the tree
  const SessionRow = ({ s, indent }: { s: ChatSession; indent: number }) => {
    const open = tabs.some(t => t.sessionId === s.id);
    const isActive = activeTab?.sessionId === s.id;
    const p = projById[s.projectId];
    return (
      <div className={`ws-row${isActive ? ' ws-active' : ''}`} onClick={() => openSession(s)} style={{
        display: 'flex', alignItems: 'center', gap: 7, padding: `5px 8px 5px ${indent}px`, borderRadius: 8, cursor: 'pointer',
        background: isActive ? 'color-mix(in srgb, var(--blue) 11%, transparent)' : 'transparent' }}>
        <Icon name="chat" size={13} style={{ flexShrink: 0, color: open ? projColor(p) : 'var(--ink-tertiary)' }} />
        {renamingId === s.id ? (
          <input autoFocus value={renameVal} onClick={e => e.stopPropagation()} onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(s.id)} onKeyDown={e => { if (e.key === 'Enter') commitRename(s.id); if (e.key === 'Escape') setRenamingId(null); }}
            style={{ flex: 1, minWidth: 0, border: '1px solid var(--blue)', borderRadius: 6, padding: '1px 5px', background: 'var(--bg)', color: 'var(--ink)', font: '500 var(--fs-footnote)/1.3 var(--font-text)' }} />
        ) : (
          <span onDoubleClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameVal(s.title); }}
            style={{ flex: 1, minWidth: 0, font: `${isActive ? 600 : 500} var(--fs-footnote)/1.35 var(--font-text)`, color: s.archived ? 'var(--ink-tertiary)' : (isActive ? 'var(--ink)' : 'var(--ink-secondary)'), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {s.title}
          </span>
        )}
        <span className="ws-act" style={{ display: 'inline-flex', gap: 1, flexShrink: 0 }}>
          {s.archived ? (
            <button title="Unarchive" onClick={e => { e.stopPropagation(); archiveSession(s, false); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--blue)' }}>
              <Icon name="archive" size={12} />
            </button>
          ) : (
            <>
              <button title={s.pinned ? 'Unpin' : 'Pin to top'} onClick={e => { e.stopPropagation(); togglePin(s); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: s.pinned ? 'var(--blue)' : 'var(--ink-tertiary)' }}>
                <Icon name="bookmark" size={12} />
              </button>
              <button title="Archive chat" onClick={e => { e.stopPropagation(); archiveSession(s, true); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
                <Icon name="archive" size={12} />
              </button>
            </>
          )}
          <button title="Delete chat" onClick={e => { e.stopPropagation(); deleteSession(s.id); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
            <Icon name="trash" size={12} />
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
            <span style={{ flex: 1, font: '700 var(--fs-callout)/1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>CodeSpace</span>
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
                            <Icon name="folder" size={13} style={{ flexShrink: 0, color: projColor(p) }} />
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
                // Lift the whole project above sibling rows while its "⋯" menu is open, so the
                // dropdown isn't painted over by the next project's row (each row otherwise
                // scopes the menu's z-index to its own stacking context).
                <div key={p.id} className="ws-proj" style={menuProj === p.id ? { position: 'relative', zIndex: 60 } : undefined}>
                  <div className="ws-row ws-proj-head" onClick={() => setExpanded(e => { const n = new Set(e); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 6px', cursor: 'pointer', position: 'relative' }}>
                    <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)', flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 160ms var(--spring)' }} />
                    <Icon name="folder" size={14} style={{ flexShrink: 0, color: projColor(p) }} />
                    <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                    {chats.length > 0 && <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{chats.length}</span>}
                    <button className="ws-newchat" title="Project · settings, jobs, memory" onClick={e => { e.stopPropagation(); setMenuProj(m => m === p.id ? null : p.id); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0, position: 'relative' }}>
                      <Icon name="more" size={15} />
                    </button>
                    <button className="ws-newchat" title="New chat here" onClick={e => { e.stopPropagation(); newChat(p.id); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--blue)', flexShrink: 0 }}>
                      <Icon name="plus" size={14} stroke={2.4} />
                    </button>
                    {menuProj === p.id && (
                      <>
                        <div onClick={e => { e.stopPropagation(); setMenuProj(null); }} style={{ position: 'fixed', inset: 0, zIndex: 50 }} />
                        <div onClick={e => e.stopPropagation()} style={{ position: 'absolute', top: '100%', right: 6, zIndex: 51, marginTop: 2, minWidth: 184, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 12, boxShadow: 'var(--card-shadow)', padding: 5 }}>
                          {[
                            { key: 'settings', icon: 'settings' as const, label: 'Project settings' },
                            { key: 'instructions', icon: 'bookmark' as const, label: 'Instructions & memory' },
                            { key: 'skills', icon: 'spark' as const, label: 'Project skills' },
                            { key: 'jobs', icon: 'jobs' as const, label: 'Jobs' },
                          ].map(it => (
                            <button key={it.key} className="ws-ovf-item" onClick={() => { setMenuProj(null); openProject(p.id, it.key as ProjectSection); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8, color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>
                              <Icon name={it.icon} size={15} style={{ color: 'var(--ink-secondary)' }} /> {it.label}
                            </button>
                          ))}
                          <div style={{ height: 1, background: 'var(--separator)', margin: '5px 4px' }} />
                          {p.path && <button className="ws-ovf-item" onClick={() => { setMenuProj(null); void api.revealPath(p.path!); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8, color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}><Icon name="folder" size={15} style={{ color: 'var(--ink-secondary)' }} /> Reveal in Finder</button>}
                          <button className="ws-ovf-item" onClick={() => { setMenuProj(null); navigate('/skills-registry'); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8, color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}><Icon name="spark" size={15} style={{ color: 'var(--ink-secondary)' }} /> Skills</button>
                          <div style={{ height: 1, background: 'var(--separator)', margin: '5px 4px' }} />
                          <button className="ws-ovf-item" onClick={() => { setMenuProj(null); setConfirmDelProj(p.id); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8, color: 'var(--red, #ff3b30)', font: '500 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}><Icon name="trash" size={15} /> Delete project</button>
                        </div>
                      </>
                    )}
                  </div>
                  {isOpen && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {chats.length === 0 && (
                        <button onClick={() => newChat(p.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 5px 26px', borderRadius: 8, color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1.3 var(--font-text)', cursor: 'pointer' }}>
                          <Icon name="plus" size={12} /> New chat
                        </button>
                      )}
                      {(q || chatsAllOpen.has(p.id) ? chats : chats.slice(0, CHAT_PREVIEW)).map(s => <SessionRow key={s.id} s={s} indent={26} />)}
                      {!q && chats.length > CHAT_PREVIEW && (
                        <button onClick={() => setChatsAllOpen(prev => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 26px', borderRadius: 8, color: 'var(--blue)', font: '600 var(--fs-caption)/1.3 var(--font-text)', cursor: 'pointer' }}>
                          {chatsAllOpen.has(p.id) ? 'Show less' : `Show all ${chats.length} chats`}
                        </button>
                      )}
                      {(() => {
                        const arch = archivedByProject(p.id);
                        if (arch.length === 0) return null;
                        const aOpen = archivedOpen.has(p.id) || !!q;
                        return (
                          <>
                            <button onClick={() => setArchivedOpen(prev => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
                              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px 22px', borderRadius: 8, color: 'var(--ink-tertiary)', font: '600 var(--fs-caption)/1.3 var(--font-text)', cursor: 'pointer' }}>
                              <Icon name="chevronRight" size={11} style={{ transform: aOpen ? 'rotate(90deg)' : 'none', transition: 'transform 160ms var(--spring)' }} />
                              <Icon name="archive" size={11} /> Archived <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono)' }}>{arch.length}</span>
                            </button>
                            {aOpen && arch.map(s => <SessionRow key={s.id} s={s} indent={26} />)}
                          </>
                        );
                      })()}
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
                      : t.kind === 'image'
                      ? <Icon name="image" size={12} style={{ color: 'var(--purple, #8b5cf6)', flexShrink: 0 }} />
                      : t.kind === 'project'
                      ? <Icon name="folder" size={12} style={{ color: projColor(p), flexShrink: 0 }} />
                      : <Icon name="chat" size={12} style={{ color: projColor(p), flexShrink: 0 }} />}
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
                            <Icon name={t.kind === 'file' ? 'file' : t.kind === 'image' ? 'image' : 'chat'} size={13} style={{ flexShrink: 0, color: t.kind && t.kind !== 'chat' ? 'var(--ink-secondary)' : projColor(p) }} />
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
                    : t.kind === 'project'
                    ? <ProjectPanel projectId={t.projectId} section={t.projectSection} />
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

      {confirmDelProj && (() => {
        const p = projById[confirmDelProj];
        const chatCount = sessions.filter(s => s.projectId === confirmDelProj).length;
        return (
          <div onClick={() => setConfirmDelProj(null)} style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(8,10,30,0.34)', backdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', padding: 20 }}>
            <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" style={{ width: 'min(420px, 100%)', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 16, boxShadow: 'var(--shadow-lg, 0 24px 70px rgba(15,20,60,0.32))', padding: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <span style={{ width: 40, height: 40, borderRadius: 11, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--red, #ff3b30) 14%, transparent)', color: 'var(--red, #ff3b30)' }}>
                  <Icon name="trash" size={20} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ font: '700 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>Delete project?</div>
                  <div style={{ font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p?.name ?? 'This project'}</div>
                </div>
              </div>
              <p style={{ margin: '0 0 18px', font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
                This removes the project{chatCount > 0 ? ` and its ${chatCount} chat${chatCount !== 1 ? 's' : ''}` : ''} from Maestro. {p?.path ? 'The folder on disk is left untouched.' : ''} This can’t be undone.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setConfirmDelProj(null)} style={{ height: 36, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => deleteProject(confirmDelProj)} style={{ height: 36, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--red, #ff3b30)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Delete project</button>
              </div>
            </div>
          </div>
        );
      })()}
    </AppShell>
  );
}
