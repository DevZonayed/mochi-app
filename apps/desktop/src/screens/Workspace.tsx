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
import { displayCodename, SESSION_STATE_STRIPE, SESSION_STATE_LONG_LABELS, type SessionGitState } from '../lib/git-types';
import { SessionStateDot } from './SessionStateDot';
import { useSessionStateOnly, useProjectRollupState } from '../lib/useSessionGitState';
import { formatTranscript, type TranscriptMode } from '../lib/transcript-export';
import { BranchPicker } from '../components/BranchPicker';
import { projectColor, projectInitial } from '../lib/project-color';
import { groupTabsByProject, isGroupExpanded as isGroupExpandedFn, prunePinnedGroups } from '../lib/tab-grouping';
import { AddProjectModal } from '../components/AddProjectModal';
import { WorkspaceOverview } from '../components/WorkspaceOverview';

/** A small spinning ring — shown on a session/project that has a job running. */
function Loader({ size = 13, color = 'var(--blue)' }: { size?: number; color?: string }) {
  return <span aria-label="working" style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0, boxSizing: 'border-box', border: `2px solid color-mix(in srgb, ${color} 24%, transparent)`, borderTopColor: color, animation: 'ws-spin 0.7s linear infinite' }} />;
}

/** Live per-session state dot for the rail. Subscribes via the shared cache. */
function SessionStateDotForId({ sessionId }: { sessionId: string }) {
  const state = useSessionStateOnly(sessionId);
  return <SessionStateDot state={state} size={7} reserveSpace />;
}

/** Live worst-state-wins rollup dot for a project's chats. */
function ProjectRollupDot({ projectId, sessionIds }: { projectId: string; sessionIds: string[] }) {
  const state = useProjectRollupState(projectId, sessionIds);
  return <SessionStateDot state={state} size={8} reserveSpace />;
}

/* Drag-and-drop project reorder — native HTML5 DnD, the same pattern as the
   Projects gallery. The parent owns the live reorder + persists it on drop. */
interface Dnd { draggingId: string | null; start: (id: string) => void; over: (id: string) => void; end: () => void }
function dragProps(dnd: Dnd, id: string) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id); } catch { /* some engines require data set */ } dnd.start(id); },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; dnd.over(id); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); dnd.end(); },
    onDragEnd: () => dnd.end(),
  };
}

const PAGE_CSS = `
  .ws-row { transition: background 120ms ease; }
  .ws-row:hover { background: var(--fill-tertiary); }
  .ws-row .ws-act { opacity: 0; transition: opacity 120ms ease; }
  .ws-row:hover .ws-act, .ws-row.ws-active .ws-act { opacity: 1; }
  .ws-tab:hover { background: var(--fill-tertiary); }
  .ws-tab .ws-tab-x { opacity: 0; transition: opacity 120ms ease; }
  .ws-tab:hover .ws-tab-x, .ws-tab.on .ws-tab-x { opacity: 1; }
  .ws-newbtn:hover { background: var(--fill-secondary) !important; }
  .ws-tabs::-webkit-scrollbar { height: 0; }
  /* project groups in the tab strip — a thin 1px vertical divider between
     groups and a 3px colored stripe at the start of each group so the eye
     can pick out which chat belongs to which project at a glance */
  .ws-tab-group { display: flex; align-items: stretch; flex-shrink: 0; }
  .ws-tab-group + .ws-tab-group { border-left: 1px solid var(--separator); }
  .ws-tab-group-stripe { width: 3px; flex-shrink: 0; }
  /* avatar-only tabs (non-active project groups). Width-animate on
     expand/collapse so the strip rearranges smoothly, not abruptly. */
  .ws-tab { transition: background 120ms ease, color 120ms ease, max-width 150ms ease-out, padding 150ms ease-out; }
  .ws-tab-avatar {
    width: 28px; max-width: 28px;
    padding: 0 !important;
    display: grid; place-items: center;
    gap: 0;
  }
  /* tooltip on collapsed avatar tabs — instant (no >100ms delay) */
  .ws-tab-avatar-tip {
    position: absolute; top: calc(100% + 4px); left: 50%; transform: translateX(-50%);
    background: var(--bg-elevated); color: var(--ink);
    border: 0.5px solid var(--separator); border-radius: 8px;
    padding: 5px 9px; font: 600 var(--fs-caption)/1.2 var(--font-text);
    box-shadow: var(--card-shadow); white-space: nowrap;
    pointer-events: none; opacity: 0; z-index: 50;
    transition: opacity 60ms ease;
  }
  .ws-tab-avatar:hover .ws-tab-avatar-tip,
  .ws-tab-avatar:focus-visible .ws-tab-avatar-tip { opacity: 1; }
  /* group pin chevron — manual control to keep a group expanded */
  .ws-group-pin { opacity: 0.55; transition: opacity 120ms ease, background 120ms ease; }
  .ws-group-pin:hover { opacity: 1; background: var(--fill-tertiary); }
  .ws-group-pin.on { opacity: 1; }
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
  @keyframes ws-spin { to { transform: rotate(360deg); } }
  /* overflow menu of open tabs — so every open chat is one click away even
     when the tab strip is scrolled past the edge */
  .ws-ovf-item:hover { background: var(--fill-tertiary); }
`;

type ProjectSection = 'settings' | 'instructions' | 'jobs' | 'skills';
interface Tab { key: string; projectId: string; sessionId: string | null; title: string; kind?: 'chat' | 'file' | 'image' | 'project'; filePath?: string; imageAssetId?: string; imagePath?: string; projectSection?: ProjectSection;
  /** Non-default base branch picked via <BranchPicker /> for a not-yet-sent
      "New chat" tab. Forwarded into sendChat so the session's worktree forks
      from it on first send. Default-branch picks leave this undefined so the
      tab title stays clean (no `· master` suffix). */
  base?: string;
}

const TABS_KEY = 'maestro.workspace.tabs';
const EXPANDED_KEY = 'maestro.workspace.expanded';
// Tab strip: which project groups the user pinned open. Persisted across
// restarts so a two-project split layout survives a relaunch.
const TAB_GROUP_PIN_KEY = 'maestro.workspace.tabGroupsPinned';

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}
const projColor = (p?: Project): string => projectColor(p ?? null);
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

/** A row in the per-tab context menu — icon + label + optional ⌘-shortcut hint. */
function MenuRow({ icon, label, shortcut, onClick, tone = 'default' }: { icon: IconName; label: string; shortcut?: string; onClick: (e: React.MouseEvent) => void; tone?: 'default' | 'danger' | 'good' }) {
  const color = tone === 'danger' ? 'var(--red, #ff3b30)' : tone === 'good' ? 'var(--green)' : 'var(--ink)';
  return (
    <button role="menuitem" className="ws-ovf-item" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8, color, font: '500 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>
      <Icon name={icon} size={14} style={{ flexShrink: 0, color: tone === 'default' ? 'var(--ink-secondary)' : color }} />
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {shortcut && <span style={{ flexShrink: 0, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', letterSpacing: '0.04em' }}>{shortcut}</span>}
    </button>
  );
}

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
  // Which project's "+" button has the <BranchPicker /> popover open (one at a time).
  const [pickerProj, setPickerProj] = React.useState<string | null>(null);
  // Anchor for the open picker — attached to the live "+" button so the portaled
  // popover positions itself against it (escapes the sidebar's overflow clip).
  const pickerAnchorRef = React.useRef<HTMLButtonElement | null>(null);
  // Project pending a delete confirmation (the destructive modal).
  const [confirmDelProj, setConfirmDelProj] = React.useState<string | null>(null);
  // Reveal soft-hidden projects in the rail (off by default).
  const [showHidden, setShowHidden] = React.useState(false);
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
  // Per-tab right-click context menu (Rename / Copy transcript / Close), à la Conductor.
  const [tabMenu, setTabMenu] = React.useState<{ key: string; x: number; y: number } | null>(null);
  const [menuCopied, setMenuCopied] = React.useState<TranscriptMode | null>(null); // ✓ flash inside the open menu
  const [copyHint, setCopyHint] = React.useState<string | null>(null);             // transient toast after a copy
  const copyHintTimer = React.useRef<number | null>(null);
  // active chat's turns, lifted from each ChatThread, for the "Changed files" panel
  const [turnsByTab, setTurnsByTab] = React.useState<Record<string, Job[]>>({});
  // Sessions with a job running/pending right now — drives the sidebar loading spinners.
  const [runningSessions, setRunningSessions] = React.useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = React.useState(false); // in-workspace add-project modal
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(() => { try { return localStorage.getItem('maestro.workspace.sidebar') === '0'; } catch { return false; } });
  const toggleSidebar = () => setSidebarCollapsed(c => { const n = !c; try { localStorage.setItem('maestro.workspace.sidebar', n ? '0' : '1'); } catch { /* ignore */ } return n; });

  // Tab strip project grouping (Track 6):
  //   – `pinnedGroups` = projects the user manually pinned open. Persisted.
  //   – `peekGroup`    = the one non-active group the user clicked open to
  //     "peek" at — collapses again when they click a different one. Not
  //     persisted (transient peek, not a layout choice).
  const [pinnedGroups, setPinnedGroups] = React.useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(TAB_GROUP_PIN_KEY) || '[]')); } catch { return new Set(); }
  });
  const [peekGroup, setPeekGroup] = React.useState<string | null>(null);
  React.useEffect(() => { try { localStorage.setItem(TAB_GROUP_PIN_KEY, JSON.stringify([...pinnedGroups])); } catch { /* ignore */ } }, [pinnedGroups]);
  const toggleGroupPin = (projectId: string) => setPinnedGroups(prev => {
    const n = new Set(prev); if (n.has(projectId)) n.delete(projectId); else n.add(projectId); return n;
  });

  const projById = React.useMemo(() => { const m: Record<string, Project> = {}; projects.forEach(p => { m[p.id] = p; }); return m; }, [projects]);

  // Drag-and-drop reorder for the sidebar project list. Reorders `projects` live
  // as you drag a header over another, then persists the order on drop (the store
  // sorts by it, so it survives reload + syncs to remotes).
  const dragIdRef = React.useRef<string | null>(null);
  const lastOverRef = React.useRef<string | null>(null);
  const projOrderRef = React.useRef<string[]>([]);
  const [draggingProj, setDraggingProj] = React.useState<string | null>(null);
  React.useEffect(() => { projOrderRef.current = projects.map(p => p.id); }, [projects]);
  const projDnd: Dnd = React.useMemo(() => ({
    draggingId: draggingProj,
    start: (id) => { dragIdRef.current = id; lastOverRef.current = id; setDraggingProj(id); },
    over: (overId) => {
      const from = dragIdRef.current;
      if (!from || overId === from || lastOverRef.current === overId) return;
      lastOverRef.current = overId;
      setProjects(ps => {
        const fromIdx = ps.findIndex(p => p.id === from);
        const toIdx = ps.findIndex(p => p.id === overId);
        if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return ps;
        const next = [...ps]; const [moved] = next.splice(fromIdx, 1); next.splice(toIdx, 0, moved); return next;
      });
    },
    end: () => {
      const moved = dragIdRef.current; dragIdRef.current = null; lastOverRef.current = null; setDraggingProj(null);
      if (moved) void api.reorderProjects(projOrderRef.current).catch(() => { void api.listProjects().then(setProjects).catch(() => {}); });
    },
  }), [draggingProj]);

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
      // DEDUPE saved entries by sessionId — a previous race in openSession/seed
      // paths could persist the same chat twice, which on restore renders TWO
      // ChatThreads at `position: absolute; inset: 0` (same key, both matching
      // activeKey), so they stack on top of each other and the user sees the
      // "screen breaking" overlap on resume. Keep first wins.
      const seenSid = new Set<string>();
      const rebuilt: Tab[] = (saved.tabs || [])
        .map((t): Tab | null => {
          if (!t?.sessionId || seenSid.has(t.sessionId)) return null;
          seenSid.add(t.sessionId);
          const s = sessions.find(x => x.id === t.sessionId);
          return s ? { key: s.id, projectId: s.projectId, sessionId: s.id, title: s.title } : null;
        })
        .filter((t): t is Tab => !!t);
      if (rebuilt.length) { setTabs(rebuilt); setActiveKey(rebuilt.find(t => t.key === saved.active)?.key ?? rebuilt[0].key); }
    } catch { /* ignore */ }
  }, [sessions]);

  // persist tabs (only the session-backed ones survive a relaunch)
  React.useEffect(() => {
    try {
      // Dedupe by sessionId on the way OUT too, so even if `tabs` state
      // briefly held a duplicate it can't poison a future cold start.
      const seenSid = new Set<string>();
      const payload = {
        tabs: tabs
          .filter(t => t.sessionId)
          .filter(t => { if (seenSid.has(t.sessionId!)) return false; seenSid.add(t.sessionId!); return true; })
          .map(t => ({ projectId: t.projectId, sessionId: t.sessionId })),
        active: activeKey,
      };
      localStorage.setItem(TABS_KEY, JSON.stringify(payload));
    } catch { /* ignore */ }
  }, [tabs, activeKey]);

  React.useEffect(() => { try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch { /* ignore */ } }, [expanded]);

  // LIVE: keep the tree + tab titles current.
  React.useEffect(() => {
    const unsub = api.subscribe({
      onJob: (job) => {
        const sid = job.sessionId; if (!sid) return;
        const running = job.status === 'running' || job.status === 'pending';
        setRunningSessions(prev => {
          if (running === prev.has(sid)) return prev;
          const next = new Set(prev); if (running) next.add(sid); else next.delete(sid); return next;
        });
      },
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

  // Seed the "working" indicators with any jobs already running when we open.
  React.useEffect(() => {
    let alive = true;
    api.listJobs().then(jobs => { if (alive) setRunningSessions(new Set(jobs.filter(j => (j.status === 'running' || j.status === 'pending') && j.sessionId).map(j => j.sessionId as string))); }).catch(() => {});
    return () => { alive = false; };
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

  // Add-project: any of the three modal flows (from folder, new, clone)
  // reaches us through this callback. We update the in-memory list, auto-
  // expand the entry so the user sees the new project immediately, and
  // raise the standard transient toast — no navigation, ever.
  const onProjectAdded = React.useCallback((proj: Project) => {
    setProjects(ps => (ps.some(x => x.id === proj.id) ? ps : [proj, ...ps]));
    setExpanded(e => new Set(e).add(proj.id));
    setCopyHint(`Project '${proj.name}' added — click to open chat`);
    if (copyHintTimer.current) window.clearTimeout(copyHintTimer.current);
    copyHintTimer.current = window.setTimeout(() => setCopyHint(null), 2400);
  }, []);

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
    // Dedup INSIDE the functional updater — relying on `tabs` from the closure
    // is racy: two rapid clicks (or a click+seed) both see the same stale
    // closure with `existing === undefined`, both append, and we end up with
    // TWO tabs sharing the same key. They both then satisfy
    // `t.key === activeKey` in the tab pane render and stack on top of each
    // other at `position:absolute; inset:0`, which the user sees as the
    // chat "screen breaking" / overlapping content on resume.
    let nextActiveKey = s.id;
    setTabs(ts => {
      const existing = ts.find(t => t.sessionId === s.id || t.key === s.id);
      if (existing) { nextActiveKey = existing.key; return ts; }
      return [...ts, { key: s.id, projectId: s.projectId, sessionId: s.id, title: s.title }];
    });
    setActiveKey(nextActiveKey);
  };
  /** Open a fresh "New chat" tab in `projectId`. Pass `base` to fork its
      worktree from a specific branch (the picker's path); omit it for the
      legacy default-branch flow (⌘/Ctrl+click on the "+" button). */
  const newChat = (projectId: string, base?: string) => {
    const key = `new:${newCounter.current++}`;
    setTabs(ts => [...ts, { key, projectId, sessionId: null, title: 'New chat', ...(base ? { base } : {}) }]);
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
  // Toggle a project's reversible soft-hide — optimistic, persisted via the
  // shared updateProject path (syncs to the gallery + mobile too).
  const setHidden = (id: string, hidden: boolean) => {
    setProjects(ps => ps.map(p => p.id === id ? { ...p, hidden } : p));
    void api.updateProject(id, { hidden }).catch(() => { api.listProjects().then(setProjects).catch(() => {}); });
  };
  const commitRename = (id: string) => {
    const title = renameVal.trim(); setRenamingId(null);
    if (!title) return;
    setSessions(ss => ss.map(s => (s.id === id ? { ...s, title } : s)));
    setTabs(ts => ts.map(t => (t.sessionId === id ? { ...t, title } : t)));
    void api.renameSession(id, title).catch(() => {});
  };

  // ── Copy transcript (concise | full) — the chat tab's context menu, à la Conductor ──
  const showCopyHint = (msg: string) => {
    setCopyHint(msg);
    if (copyHintTimer.current) window.clearTimeout(copyHintTimer.current);
    copyHintTimer.current = window.setTimeout(() => setCopyHint(null), 1700);
  };
  const copyTranscript = async (tab: Tab, mode: TranscriptMode) => {
    if (!tab.sessionId) { showCopyHint('Send a message first'); return; }
    try {
      // The active tab's turns are already lifted into turnsByTab (live); fall back to a fetch.
      const cached = turnsByTab[tab.key];
      const jobs = cached && cached.length ? cached : await api.listJobs(undefined, tab.sessionId);
      if (!jobs.length) { showCopyHint('Nothing to copy yet'); return; }
      await navigator.clipboard?.writeText(formatTranscript(jobs, { mode, title: tab.title }));
      showCopyHint(mode === 'concise' ? 'Copied concise transcript' : 'Copied full transcript');
    } catch { showCopyHint('Copy failed'); }
  };
  const openTabMenu = (e: React.MouseEvent, t: Tab) => {
    e.preventDefault(); e.stopPropagation();
    setActiveKey(t.key); setMenuCopied(null);
    setTabMenu({ key: t.key, x: e.clientX, y: e.clientY });
  };
  const doMenuCopy = (t: Tab, mode: TranscriptMode) => {
    void copyTranscript(t, mode);
    setMenuCopied(mode); // ✓ flashes on the row, then the menu closes
    window.setTimeout(() => { setTabMenu(null); setMenuCopied(null); }, 620);
  };
  // ⌘⌥C → copy the active chat's concise transcript. Option+C emits 'ç', so match e.code.
  // (A custom chord with no native-menu accelerator, so preventDefault is reliable —
  //  unlike ⌘W, which Electron's default menu owns as Close Window.)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyC') {
        const t = tabs.find(x => x.key === activeKey);
        if (t && (t.kind === 'chat' || !t.kind) && t.sessionId) { e.preventDefault(); void copyTranscript(t, 'concise'); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, activeKey, turnsByTab]); // re-bind so the handler reads fresh tabs/turns

  // Filtering: by project kind + a fuzzy name search over projects AND chats.
  const q = query.trim().toLowerCase();
  const kindMatch = (p?: Project) => kindFilter === 'all' || projKind(p) === kindFilter;
  const chatHit = (s: ChatSession) => !q || s.title.toLowerCase().includes(q);
  const projHit = (p: Project) => !q || p.name.toLowerCase().includes(q) || sessions.some(s => s.projectId === p.id && s.title.toLowerCase().includes(q));

  // CodeSpace shows coding work only — design projects live in the Design tab.
  const codeProjects = projects.filter(p => projKind(p) !== 'design');
  const kindCount = (k: KindFilter) => (k === 'all' ? codeProjects.length : codeProjects.filter(p => projKind(p) === k).length);
  // Soft-hidden projects drop out of the rail unless "Show hidden" is on.
  const hiddenCount = codeProjects.filter(p => p.hidden && kindMatch(p) && projHit(p)).length;
  const visibleProjects = codeProjects.filter(p => kindMatch(p) && projHit(p) && (showHidden || !p.hidden));
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
    // Live git/PR state → left-border stripe colour (gray=clean, amber=
    // uncommitted, blue=PR open, green=mergeable, red=conflicts, etc.). The
    // hook subscribes to the shared cache, so this only re-renders when THIS
    // session's status fires. `no-repo` → transparent stripe (invisible) so
    // the row layout stays the same and we don't surface a misleading dot.
    const liveState: SessionGitState | null = useSessionStateOnly(s.id);
    const stripeColor = liveState ? SESSION_STATE_STRIPE[liveState] : 'transparent';
    const stripeLabel = liveState && liveState !== 'no-repo' ? SESSION_STATE_LONG_LABELS[liveState] : null;
    return (
      <div className={`ws-row${isActive ? ' ws-active' : ''}`} onClick={() => openSession(s)}
        aria-label={stripeLabel ? `${s.title} — ${stripeLabel}` : s.title}
        title={stripeLabel ?? undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          // Internal padding adjusted so the 4px stripe takes the leftmost
          // pixels and the row content visually starts at the same place.
          padding: `5px 8px 5px ${Math.max(8, indent - 4)}px`,
          borderRadius: 8, cursor: 'pointer',
          borderLeft: `4px solid ${stripeColor}`,
          background: isActive ? 'color-mix(in srgb, var(--blue) 11%, transparent)' : 'transparent',
        }}>
        {runningSessions.has(s.id)
          ? <Loader size={13} color={projColor(p)} />
          : <Icon name={s.branch ? 'gitMerge' : 'chat'} size={13} style={{ flexShrink: 0, color: open ? projColor(p) : 'var(--ink-tertiary)' }} />}
        <SessionStateDotForId sessionId={s.id} />
        {renamingId === s.id ? (
          <input autoFocus value={renameVal} onClick={e => e.stopPropagation()} onChange={e => setRenameVal(e.target.value)}
            onBlur={() => commitRename(s.id)} onKeyDown={e => { if (e.key === 'Enter') commitRename(s.id); if (e.key === 'Escape') setRenamingId(null); }}
            style={{ flex: 1, minWidth: 0, border: '1px solid var(--blue)', borderRadius: 6, padding: '1px 5px', background: 'var(--bg)', color: 'var(--ink)', font: '500 var(--fs-footnote)/1.3 var(--font-text)' }} />
        ) : (
          <span title="Double-click to rename" onDoubleClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameVal(s.title); }}
            style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6, font: `${isActive ? 600 : 500} var(--fs-footnote)/1.35 var(--font-text)`, color: s.archived ? 'var(--ink-tertiary)' : (isActive ? 'var(--ink)' : 'var(--ink-secondary)') }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
            {s.codename && (
              <span title={`Session codename · ${displayCodename(s.codename)}`} style={{ flexShrink: 0, font: '600 9px/1 var(--font-mono)', letterSpacing: '0.05em', color: 'var(--ink-tertiary)', textTransform: 'uppercase' }}>
                {s.codename}
              </span>
            )}
          </span>
        )}
        <span className="ws-act" style={{ display: 'inline-flex', gap: 1, flexShrink: 0 }}>
          <button title="Rename chat" onClick={e => { e.stopPropagation(); setRenamingId(s.id); setRenameVal(s.title); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)' }}>
            <Icon name="pencil" size={12} />
          </button>
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

  // ── Tab strip: group open tabs by project, preserving the order in which
  // each project first appeared (so the layout doesn't reshuffle as the user
  // opens/closes tabs). Pure helper — tested in tab-grouping.test.ts.
  const tabGroups = React.useMemo(() => groupTabsByProject(tabs), [tabs]);

  const activeProjectId = activeTab?.projectId ?? null;
  const isGroupExpanded = (projectId: string): boolean => isGroupExpandedFn(projectId, {
    activeProjectId, pinnedGroups, peekGroup, groupCount: tabGroups.length,
  });
  const peekOpen = (projectId: string) => {
    // Click on a collapsed group's avatar → expand it (and collapse the previously-peeked one).
    setPeekGroup(prev => (prev === projectId ? null : projectId));
  };

  // Clean up peek state when the peeked project is closed entirely or when the
  // user clicks it active (the "active" rule already expands it, so peek becomes redundant).
  React.useEffect(() => {
    if (peekGroup && (peekGroup === activeProjectId || !tabGroups.some(g => g.projectId === peekGroup))) {
      setPeekGroup(null);
    }
  }, [peekGroup, activeProjectId, tabGroups]);

  // Forget pin state for projects whose tabs are all closed. Keeps the persisted
  // set small + avoids stale pins re-appearing when a long-gone project is reopened later.
  React.useEffect(() => {
    if (!pinnedGroups.size) return;
    const pruned = prunePinnedGroups(pinnedGroups, tabGroups);
    if (pruned.size !== pinnedGroups.size) setPinnedGroups(pruned);
  }, [tabGroups, pinnedGroups]);

  // Keyboard map for the tab strip:
  //   ⌘⇧E  expand every group (pin them all)
  //   ⌘⇧C  collapse every non-active group (clear pins + peek)
  //   ⌥←/→ cycle through currently-visible tabs (skips collapsed avatars'
  //         hidden state by always activating the next tab — selecting it
  //         immediately expands its group via the active-projectId rule)
  //   ⌘1…9 jump to the Nth visible tab
  // We avoid the bare ⌘←/→ because Electron / web routing already owns them.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ── group expand / collapse (⌘⇧E / ⌘⇧C) ──
      if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey) {
        if (e.code === 'KeyE') {
          e.preventDefault();
          setPinnedGroups(new Set(tabGroups.map(g => g.projectId)));
          return;
        }
        if (e.code === 'KeyC') {
          e.preventDefault();
          setPinnedGroups(new Set());
          setPeekGroup(null);
          return;
        }
      }
      // ── ⌥←/⌥→: cycle through tabs in tab-strip order ──
      // (⌘←/→ are reserved by macOS for history back/forward in many shells.)
      if (e.altKey && !e.metaKey && !e.shiftKey && !e.ctrlKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        const all = tabGroups.flatMap(g => g.tabs);
        if (!all.length) return;
        const idx = activeKey ? all.findIndex(t => t.key === activeKey) : -1;
        const delta = e.code === 'ArrowRight' ? 1 : -1;
        const next = all[(Math.max(0, idx) + delta + all.length) % all.length];
        if (next) { e.preventDefault(); setActiveKey(next.key); }
        return;
      }
      // ── ⌘1…⌘9: jump to the Nth tab ──
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
        const n = parseInt(e.code.slice(5), 10) - 1;
        const all = tabGroups.flatMap(g => g.tabs);
        const tgt = all[n];
        if (tgt) { e.preventDefault(); setActiveKey(tgt.key); }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabGroups, activeKey]);

  return (
    <AppShell active="workspace">
      <style>{PAGE_CSS}</style>
      <div style={{ height: '100%', display: 'flex', minHeight: 0 }}>
        {/* ── left tree: pinned + projects → chats ── */}
        <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '0.5px solid var(--separator)', background: 'var(--bg-grouped)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 14px 10px' }}>
            <Icon name="terminal" size={16} style={{ color: 'var(--blue)' }} />
            <span style={{ flex: 1, font: '700 var(--fs-callout)/1 var(--font-display)', letterSpacing: '-0.01em', color: 'var(--ink)' }}>CodeSpace</span>
            {/* "+" now opens the in-workspace <AddProjectModal />; no more
                redirect to /projects (that broke the user's "everything in
                workspace" expectation). The modal handles all three flows
                (folder / new / clone) without leaving the page. */}
            <button onClick={() => setAddOpen(true)} title="Add a project" className="ws-newbtn"
              style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'transparent', color: addOpen ? 'var(--ink)' : 'var(--ink-tertiary)' }}>
              <Icon name="plus" size={16} stroke={2.4} />
            </button>
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

          {/* Workspace-wide attention strip — rolls up every project's
              session git states into "X conflicts, Y mergeable, Z to push"
              rows so the operator never has to tour each project to know
              what needs them. Lives ABOVE the projects list, persists open. */}
          <WorkspaceOverview onOpenSession={(projectId, sessionId) => {
            const sess = sessions.find(s => s.id === sessionId);
            if (sess) {
              openSession(sess);
              if (!expanded.has(projectId)) setExpanded(e => new Set(e).add(projectId));
            }
          }} />

          <div className="ws-tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' }}>
            {projects.length === 0 && (
              <div style={{ padding: '40px 14px', textAlign: 'center', font: '400 var(--fs-footnote)/1.55 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                No projects yet.
                <button onClick={() => setAddOpen(true)} style={{ display: 'block', margin: '12px auto 0', height: 32, padding: '0 14px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Create a project</button>
              </div>
            )}

            {pinned.length > 0 && (
              <>
                {sectionLabel('Pinned')}
                {pinned.map(s => <SessionRow key={'p' + s.id} s={s} indent={8} />)}
              </>
            )}

            {visibleProjects.length > 0 && sectionLabel(kindFilter === 'all' ? 'Projects' : `${kindOf(kindFilter).label} projects`)}
            {hiddenCount > 0 && (
              <button onClick={() => setShowHidden(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left', padding: '4px 8px', margin: '0 0 2px', borderRadius: 7, color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>
                <Icon name={showHidden ? 'eye' : 'eyeOff'} size={13} /> {showHidden ? `Hide ${hiddenCount} hidden` : `Show ${hiddenCount} hidden`}
              </button>
            )}
            {projects.length > 0 && visibleProjects.length === 0 && (
              <div style={{ padding: '24px 14px', textAlign: 'center', font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                No {kindFilter === 'all' ? '' : kindOf(kindFilter).label.toLowerCase() + ' '}projects{q ? ' match' : ''}.
                {(q || kindFilter !== 'all') && <button onClick={() => { setQuery(''); setKindFilter('all'); }} style={{ display: 'block', margin: '10px auto 0', height: 28, padding: '0 12px', borderRadius: 'var(--r-pill)', background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>Clear filters</button>}
              </div>
            )}
            {visibleProjects.map(p => {
              const chats = sessionsByProject(p.id);
              const isOpen = expanded.has(p.id) || (!!q && chats.length > 0);
              const projRunning = chats.some(s => runningSessions.has(s.id));
              const projActive = p.id === activeTab?.projectId;
              return (
                // Lift the whole project above sibling rows while its "⋯" menu OR its branch
                // picker is open, so the popover isn't painted over by the next project's row
                // (the sticky `.ws-proj-head` is a z-index:2 stacking context that otherwise
                // traps the popover's z-index, so later sibling headers paint on top of it).
                <div key={p.id} className="ws-proj" style={(menuProj === p.id || pickerProj === p.id) ? { position: 'relative', zIndex: 60 } : undefined}>
                  <div className="ws-row ws-proj-head" {...dragProps(projDnd, p.id)} onClick={() => setExpanded(e => { const n = new Set(e); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 6px', cursor: 'pointer', position: 'relative', userSelect: 'none',
                      opacity: draggingProj === p.id ? 0.45 : undefined,
                      background: projActive ? `color-mix(in srgb, ${projColor(p)} 13%, var(--bg-grouped))` : undefined }}>
                    {projActive && <span style={{ position: 'absolute', left: 0, top: 5, bottom: 5, width: 2.5, borderRadius: 2, background: projColor(p) }} />}
                    <Icon name="chevronRight" size={13} style={{ color: 'var(--ink-tertiary)', flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 160ms var(--spring)' }} />
                    {projRunning
                      ? <Loader size={14} color={projColor(p)} />
                      : <Icon name="folder" size={14} style={{ flexShrink: 0, color: projColor(p), opacity: p.hidden ? 0.5 : undefined }} />}
                    <span style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 6, font: '600 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', opacity: p.hidden ? 0.5 : undefined }}>
                      <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                      <ProjectRollupDot projectId={p.id} sessionIds={chats.map(c => c.id)} />
                    </span>
                    {chats.length > 0 && <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>{chats.length}</span>}
                    <button className="ws-newchat" title="Project · settings, jobs, memory" onClick={e => { e.stopPropagation(); setMenuProj(m => m === p.id ? null : p.id); }} style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-secondary)', flexShrink: 0, position: 'relative' }}>
                      <Icon name="more" size={15} />
                    </button>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button ref={pickerProj === p.id ? pickerAnchorRef : null} className="ws-newchat" title="New chat here — pick a base branch (⌘+click to skip)"
                        onClick={e => {
                          e.stopPropagation();
                          // ⌘/Ctrl+click skips the picker → instant chat off the
                          // default branch (origin/HEAD). Preserves the zero-friction
                          // path for power users who don't care about the base.
                          if (e.metaKey || e.ctrlKey) {
                            setPickerProj(null);
                            newChat(p.id);
                            return;
                          }
                          setPickerProj(cur => cur === p.id ? null : p.id);
                          setMenuProj(null); // don't stack two popovers on the same header
                        }}
                        style={{ width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--blue)' }}>
                        <Icon name="plus" size={14} stroke={2.4} />
                      </button>
                      {/* Portaled to document.body + self-positioning against the button rect,
                          so it can't be clipped by the sidebar's overflow. */}
                      {pickerProj === p.id && (
                        <BranchPicker
                          anchorRef={pickerAnchorRef}
                          projectId={p.id}
                          onClose={() => setPickerProj(null)}
                          onPick={(branch, isDefault) => {
                            setPickerProj(null);
                            // Default → omit base so the tab title stays clean and the
                            // engine's resolveBaseBranch path handles it (same as ⌘+click).
                            newChat(p.id, isDefault ? undefined : branch);
                          }}
                        />
                      )}
                    </div>
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
                          <button className="ws-ovf-item" onClick={() => { setMenuProj(null); setHidden(p.id, !p.hidden); }} style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 9px', borderRadius: 8, color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}><Icon name={p.hidden ? 'eye' : 'eyeOff'} size={15} style={{ color: 'var(--ink-secondary)' }} /> {p.hidden ? 'Unhide project' : 'Hide project'}</button>
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
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {/* tab bar */}
          <div style={{ display: 'flex', alignItems: 'stretch', height: 42, flexShrink: 0, borderBottom: '0.5px solid var(--separator)', background: 'var(--bg-grouped)' }}>
            <div ref={tabStripRef} className="ws-tabs"
              onWheel={e => { const el = tabStripRef.current; if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY; }}
              style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}>
              {tabGroups.map(group => {
                const p = projById[group.projectId];
                const expanded = isGroupExpanded(group.projectId);
                const pinned = pinnedGroups.has(group.projectId);
                const groupName = p?.name ?? 'Project';
                const stripeColor = projColor(p);
                return (
                  <div key={group.projectId} className="ws-tab-group" role="group" aria-label={groupName}>
                    {/* 3px colored left-stripe — the at-a-glance project tint */}
                    <span className="ws-tab-group-stripe" aria-hidden="true" style={{ background: stripeColor }} />
                    {/* Pin toggle: keeps a non-active group expanded even when it isn't the active one */}
                    {tabGroups.length > 1 && (
                      <button type="button"
                        className={`ws-group-pin${pinned ? ' on' : ''}`}
                        title={pinned ? `Unpin ${groupName}` : `Pin ${groupName} expanded`}
                        aria-label={pinned ? `Unpin ${groupName}` : `Pin ${groupName} expanded`}
                        aria-pressed={pinned}
                        onClick={(e) => { e.stopPropagation(); toggleGroupPin(group.projectId); }}
                        style={{ width: 18, alignSelf: 'center', height: 26, borderRadius: 5, display: 'grid', placeItems: 'center', marginLeft: 2, color: pinned ? stripeColor : 'var(--ink-tertiary)', background: 'transparent', cursor: 'pointer', flexShrink: 0 }}>
                        <Icon name={pinned ? 'chevronDown' : 'chevronRight'} size={12} stroke={2.4} />
                      </button>
                    )}
                    {group.tabs.map(t => {
                      const on = t.key === activeKey;
                      const chatTab = (t.kind === 'chat' || !t.kind) && !!t.sessionId;
                      const editing = chatTab && renamingId === t.sessionId;
                      const collapsed = !expanded && !on; // active tab always shows its title
                      const tabIcon = t.kind === 'file'
                        ? <Icon name="file" size={12} style={{ color: 'var(--ink-secondary)', flexShrink: 0 }} />
                        : t.kind === 'image'
                        ? <Icon name="image" size={12} style={{ color: 'var(--purple, #8b5cf6)', flexShrink: 0 }} />
                        : t.kind === 'project'
                        ? <Icon name="folder" size={12} style={{ color: projColor(p), flexShrink: 0 }} />
                        : <Icon name="chat" size={12} style={{ color: projColor(p), flexShrink: 0 }} />;
                      if (collapsed) {
                        const initial = projectInitial(groupName);
                        const a11yLabel = `${t.title} (in ${groupName})`;
                        return (
                          <button key={t.key} data-tabkey={t.key}
                            type="button"
                            role="tab" aria-selected={false} aria-label={a11yLabel}
                            className={`ws-tab ws-tab-avatar`}
                            onClick={() => { peekOpen(group.projectId); setActiveKey(t.key); }}
                            onContextMenu={e => openTabMenu(e, t)}
                            style={{ position: 'relative', borderRight: '0.5px solid var(--separator)', background: 'transparent', cursor: 'pointer', height: 'auto' }}>
                            <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center',
                              background: `color-mix(in srgb, ${stripeColor} 22%, transparent)`,
                              color: stripeColor, font: '700 10px/1 var(--font-display)' }}>{initial}</span>
                            <span className="ws-tab-avatar-tip" role="tooltip">{a11yLabel}</span>
                          </button>
                        );
                      }
                      return (
                        <div key={t.key} data-tabkey={t.key}
                          role="tab" aria-selected={on}
                          className={`ws-tab${on ? ' on' : ''}`} onClick={() => setActiveKey(t.key)} onContextMenu={e => openTabMenu(e, t)}
                          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 10px 0 13px', maxWidth: 220, flexShrink: 0, cursor: 'pointer', position: 'relative',
                            borderRight: '0.5px solid var(--separator)', background: on ? 'var(--bg-elevated)' : 'transparent' }}>
                          {on && <span style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: stripeColor }} />}
                          {tabIcon}
                          {editing && t.sessionId ? (
                            <input autoFocus value={renameVal} onClick={e => e.stopPropagation()} onChange={e => setRenameVal(e.target.value)}
                              onBlur={() => commitRename(t.sessionId!)} onKeyDown={e => { if (e.key === 'Enter') commitRename(t.sessionId!); if (e.key === 'Escape') setRenamingId(null); }}
                              style={{ minWidth: 0, maxWidth: 150, border: '1px solid var(--blue)', borderRadius: 5, padding: '1px 5px', background: 'var(--bg)', color: 'var(--ink)', font: '500 var(--fs-footnote)/1 var(--font-text)' }} />
                          ) : (
                            <span title={chatTab ? 'Double-click to rename' : (t.base ? `New chat off ${t.base}` : undefined)}
                              onDoubleClick={chatTab ? (e => { e.stopPropagation(); setRenamingId(t.sessionId!); setRenameVal(t.title); }) : undefined}
                              style={{ minWidth: 0, maxWidth: 150, font: `${on ? 600 : 500} var(--fs-footnote)/1 var(--font-text)`, color: on ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {t.title}
                              {t.base && !t.sessionId && (
                                // Subtle base-branch suffix on un-sent "New chat" tabs only.
                                // Hidden once the session is real (its title takes over).
                                <span style={{ marginLeft: 5, color: 'var(--ink-tertiary)', font: '500 var(--fs-caption)/1 var(--font-mono)' }}>· {t.base}</span>
                              )}
                            </span>
                          )}
                          <button className="ws-tab-x" title="Close tab" onClick={e => { e.stopPropagation(); closeTab(t.key); }} style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
                            <Icon name="x" size={11} stroke={2.6} />
                          </button>
                        </div>
                      );
                    })}
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
                        const chatTab = (t.kind === 'chat' || !t.kind) && !!t.sessionId;
                        return (
                          <div key={t.key} className="ws-ovf-item" onClick={() => { setActiveKey(t.key); setOvfOpen(false); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 8, cursor: 'pointer', background: on ? 'color-mix(in srgb, var(--blue) 11%, transparent)' : 'transparent' }}>
                            <Icon name={t.kind === 'file' ? 'file' : t.kind === 'image' ? 'image' : 'chat'} size={13} style={{ flexShrink: 0, color: t.kind && t.kind !== 'chat' ? 'var(--ink-secondary)' : projColor(p) }} />
                            <span style={{ flex: 1, minWidth: 0, font: `${on ? 600 : 500} var(--fs-footnote)/1.25 var(--font-text)`, color: on ? 'var(--ink)' : 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                            {p && <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', flexShrink: 0, maxWidth: 70, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>}
                            {chatTab && t.sessionId && (
                              <button title="Rename chat" onClick={e => { e.stopPropagation(); setOvfOpen(false); setActiveKey(t.key); setRenamingId(t.sessionId!); setRenameVal(t.title); }} style={{ width: 18, height: 18, borderRadius: 5, display: 'grid', placeItems: 'center', color: 'var(--ink-tertiary)', flexShrink: 0 }}>
                                <Icon name="pencil" size={11} stroke={2.4} />
                              </button>
                            )}
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

          {/* Per-tab context menu (right-click) — Rename / Copy concise (⌘⌥C) / Copy full / Close. */}
          {tabMenu && (() => {
            const t = tabs.find(x => x.key === tabMenu.key);
            if (!t) return null;
            const chatTab = (t.kind === 'chat' || !t.kind) && !!t.sessionId;
            const MENU_W = 234;
            const left = Math.max(8, Math.min(tabMenu.x, window.innerWidth - MENU_W - 8));
            const top = Math.min(tabMenu.y, window.innerHeight - 196);
            return (
              <>
                <div onClick={() => setTabMenu(null)} onContextMenu={e => { e.preventDefault(); setTabMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
                <div role="menu" style={{ position: 'fixed', left, top, zIndex: 61, minWidth: MENU_W, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 12, boxShadow: 'var(--card-shadow)', padding: 5 }}>
                  {chatTab && <MenuRow icon="pencil" label="Rename chat" onClick={() => { setTabMenu(null); setActiveKey(t.key); setRenamingId(t.sessionId!); setRenameVal(t.title); }} />}
                  {chatTab && <MenuRow icon={menuCopied === 'concise' ? 'check' : 'command'} tone={menuCopied === 'concise' ? 'good' : 'default'} label={menuCopied === 'concise' ? 'Copied' : 'Copy concise transcript'} shortcut="⌘⌥C" onClick={() => doMenuCopy(t, 'concise')} />}
                  {chatTab && <MenuRow icon={menuCopied === 'full' ? 'check' : 'file'} tone={menuCopied === 'full' ? 'good' : 'default'} label={menuCopied === 'full' ? 'Copied' : 'Copy full transcript'} onClick={() => doMenuCopy(t, 'full')} />}
                  {chatTab && <div style={{ height: 1, background: 'var(--separator)', margin: '4px 8px' }} />}
                  <MenuRow icon="x" label="Close tab" onClick={() => { setTabMenu(null); closeTab(t.key); }} />
                </div>
              </>
            );
          })()}

          {/* Transient confirmation after a copy (covers the keyboard ⌘⌥C path too). */}
          {copyHint && (
            <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 70, display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)',
              font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)', pointerEvents: 'none' }}>
              <Icon name={copyHint.startsWith('Copied') ? 'check' : 'command'} size={13} stroke={2.6} style={{ color: copyHint.startsWith('Copied') ? 'var(--green)' : 'var(--ink-secondary)' }} />
              {copyHint}
            </div>
          )}

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
              {/* Belt-and-braces: if a duplicate-key tab ever slips through any
                  insertion path, only ONE entry per key is rendered. Without
                  this, two `position:absolute; inset:0` ChatThreads stack on
                  top of each other (both satisfy `t.key === activeKey`) and
                  the operator sees the chat "screen breaking" overlap. */}
              {Array.from(new Map(tabs.map(t => [t.key, t])).values()).map(t => (
                <div key={t.key} style={{ position: 'absolute', inset: 0, display: t.key === activeKey ? 'flex' : 'none' }}>
                  {t.kind === 'file' && t.filePath
                    ? <FileViewer projectId={t.projectId} filePath={t.filePath} />
                    : t.kind === 'image'
                    ? <ImageViewer assetId={t.imageAssetId} name={t.title} imagePath={t.imagePath} />
                    : t.kind === 'project'
                    ? <ProjectPanel projectId={t.projectId} section={t.projectSection} />
                    : <ChatThread flush autoFocus={t.key === activeKey} projectId={t.projectId} project={projById[t.projectId] ?? null}
                        sessionId={t.sessionId} base={t.base} onSessionCreated={onSessionCreated(t.key)} onOpenSession={openSession}
                        onTurns={js => setTurnsByTab(m => ({ ...m, [t.key]: js }))}
                        onOpenImage={(assetId, name, imagePath) => openImage(t.projectId, assetId, name, imagePath)}
                        onOpenFile={(filePath) => openFile(t.projectId, filePath)} />}
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

      {/* In-workspace add-project modal — dims the workspace but leaves it
          visible, so the user knows they did NOT navigate away. The "+"
          button above opens it; success returns through onProjectAdded. */}
      <AddProjectModal open={addOpen} onClose={() => setAddOpen(false)} onAdded={onProjectAdded} />
    </AppShell>
  );
}
