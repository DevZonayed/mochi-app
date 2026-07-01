/* The project hub — a workspace tab for a project's own settings, instructions
   (its persistent memory of how to work), and job history. Opened from the "⋯"
   menu on a project in the tree, so per-project things are one click from the
   workspace instead of buried in a separate screen. */

import React from 'react';
import { api, type Project, type Job, type ProjectMemory, type InstalledSkill, type RegistrySkillSummary, type WaChat, ApiError } from './api';
import { Icon, type IconName } from './icons';
import { Switch } from './ui';

type Section = 'settings' | 'instructions' | 'jobs' | 'memory' | 'skills' | 'whatsapp';

function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return d < 7 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}
const STATUS_TINT: Record<string, string> = {
  done: 'var(--green)', running: 'var(--blue)', failed: 'var(--red, #e5484d)',
  cancelled: 'var(--ink-tertiary)', pending: 'var(--orange, #d9821b)',
};

export function ProjectPanel({ projectId, section = 'settings' }: { projectId: string; section?: Section }) {
  const [project, setProject] = React.useState<Project | null>(null);
  const [tab, setTab] = React.useState<Section>(section);
  React.useEffect(() => { setTab(section); }, [section]);
  React.useEffect(() => { let on = true; api.getProject(projectId).then(p => { if (on) setProject(p); }).catch(() => {}); return () => { on = false; }; }, [projectId]);

  const patch = (p: Partial<Project>) => { setProject(cur => (cur ? { ...cur, ...p } : cur)); void api.updateProject(projectId, p).catch(() => {}); };

  const TABS: { key: Section; label: string; icon: IconName }[] = [
    { key: 'settings', label: 'Settings', icon: 'settings' },
    { key: 'instructions', label: 'Instructions', icon: 'bookmark' },
    { key: 'memory', label: 'Memory', icon: 'spark' },
    { key: 'skills', label: 'Skills', icon: 'spark' },
    { key: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp' },
    { key: 'jobs', label: 'Jobs', icon: 'jobs' },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg)' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 0' }}>
        <Icon name="folder" size={20} style={{ color: project?.color ? `var(--${project.color})` : 'var(--blue)' }} />
        <span style={{ flex: 1, minWidth: 0, font: '700 var(--fs-title3)/1.2 var(--font-display)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project?.name ?? 'Project'}</span>
      </div>
      {/* sub-tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '10px 14px 0', borderBottom: '0.5px solid var(--separator)' }}>
        {TABS.map(t => {
          const on = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: '8px 8px 0 0', position: 'relative',
              color: on ? 'var(--ink)' : 'var(--ink-secondary)', font: `${on ? 600 : 500} var(--fs-subhead)/1 var(--font-text)`, cursor: 'pointer' }}>
              <Icon name={t.icon} size={15} /> {t.label}
              {on && <span style={{ position: 'absolute', left: 8, right: 8, bottom: -1, height: 2, borderRadius: 2, background: 'var(--blue)' }} />}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 16px 28px' }}>
        {tab === 'settings' && project && <SettingsBody project={project} patch={patch} />}
        {tab === 'instructions' && project && <InstructionsBody project={project} patch={patch} />}
        {tab === 'memory' && <MemoryBody projectId={projectId} />}
        {tab === 'skills' && <SkillsBody projectId={projectId} />}
        {tab === 'whatsapp' && <WhatsAppBody projectId={projectId} />}
        {tab === 'jobs' && <JobsBody projectId={projectId} />}
      </div>
    </div>
  );
}

function SkillsBody({ projectId }: { projectId: string }) {
  const [installed, setInstalled] = React.useState<InstalledSkill[]>([]);
  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<RegistrySkillSummary[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [meta, setMeta] = React.useState<{ count: number; total?: number; uniqueRepos?: number } | null>(null);
  const reloadInstalled = React.useCallback(() => {
    api.listProjectSkills(projectId).then(r => setInstalled(r.skills)).catch(() => setInstalled([]));
  }, [projectId]);
  React.useEffect(() => {
    reloadInstalled();
    api.skillRegistryMeta().then(m => setMeta(m as typeof meta)).catch(() => {});
    api.searchSkills('', 12).then(r => setResults(r.results)).catch(() => setResults([]));
  }, [reloadInstalled]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = async (term = q) => {
    setBusy('__search');
    try { const r = await api.searchSkills(term, 18); setResults(r.results); } catch { setResults([]); }
    setBusy(null);
  };
  const add = async (s: RegistrySkillSummary) => {
    if (s.enabled === false) return;
    setBusy(s.id);
    try {
      await api.addSkillToProject(projectId, {
        skillId: s.id,
        name: s.name,
        description: s.description,
        risk: s.risk,
        source: s.source,
        version: s.version,
        disabledReason: s.disabledReason,
        mirrorRepo: s.sourceRepo || s.mirrorRepo,
        auditStatus: s.auditStatus,
      });
      reloadInstalled();
    } catch { /* fail soft */ }
    setBusy(null);
  };
  const remove = async (s: InstalledSkill) => {
    setInstalled(xs => xs.filter(x => x.id !== s.id));
    try { await api.removeSkillFromProject(projectId, s.id); } catch { reloadInstalled(); }
  };
  const toggle = async (s: InstalledSkill) => {
    const next = s.enabled === false; // currently disabled → enabling
    setInstalled(xs => xs.map(x => (x.id === s.id ? { ...x, enabled: next } : x)));
    try { await api.setProjectSkillEnabled(projectId, s.id, next); } catch { reloadInstalled(); }
  };
  const installedIds = new Set(installed.map(s => s.id));
  const activeCount = installed.filter(s => s.enabled !== false).length;
  const riskTint = (r?: string) => {
    const v = (r || '').toUpperCase();
    if (v === 'MEDIUM') return 'var(--orange)';
    if (v === 'LOW' || v === 'SAFE' || v === 'NONE') return 'var(--green)';
    if (v === 'HIGH' || v === 'CRITICAL') return 'var(--red, #e5484d)';
    return 'var(--ink-tertiary)';
  };
  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 9 }}>
          <div style={{ font: '700 var(--fs-headline)/1 var(--font-display)', color: 'var(--ink)' }}>Project skills</div>
          <span style={{ font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            {activeCount} active{installed.length !== activeCount ? ` · ${installed.length - activeCount} disabled` : ''}{meta ? ` · ${meta.count} in registry` : ''}
          </span>
        </div>
        <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
          Everything active on this project — including skills the agent installed itself mid-run. Toggle to disable a skill without losing it (its <code>SKILL.md</code> is set aside); Remove deletes it from <code>.claude/skills/</code>.
        </div>
      </div>

      {installed.length > 0 ? (
        <div style={{ border: '0.5px solid var(--separator)', borderRadius: 12, background: 'var(--surface)', overflow: 'hidden' }}>
          {installed.slice().sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false)).map((s, i, arr) => {
            const on = s.enabled !== false;
            return (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: i === arr.length - 1 ? 'none' : '0.5px solid var(--separator)', opacity: on ? 1 : 0.6 }}>
                <Icon name="spark" size={15} style={{ color: on ? 'var(--indigo)' : 'var(--ink-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    <span style={{ font: '600 var(--fs-footnote)/1.25 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                    {s.addedBy === 'agent' && <span title="The agent installed this itself during a run" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0, height: 16, padding: '0 6px', borderRadius: 'var(--r-pill)', background: 'color-mix(in srgb, var(--indigo) 14%, transparent)', color: 'var(--indigo)', font: '600 var(--fs-caption)/16px var(--font-text)' }}><Icon name="bolt" size={10} /> by agent</span>}
                    {!on && <span style={{ flexShrink: 0, height: 16, padding: '0 6px', borderRadius: 'var(--r-pill)', background: 'var(--fill-tertiary)', color: 'var(--ink-tertiary)', font: '600 var(--fs-caption)/16px var(--font-text)' }}>Disabled</span>}
                  </span>
                  <span style={{ display: 'block', font: '400 var(--fs-caption)/1.35 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>.claude/skills/{s.slug}/SKILL.md{s.sha256 ? ` · ${s.sha256.slice(0, 12)}` : ''}</span>
                </span>
                <Switch on={on} onChange={() => void toggle(s)} />
                <button onClick={() => void remove(s)} style={{ height: 28, padding: '0 10px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--surface)', color: 'var(--ink-secondary)', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>Remove</button>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ padding: '18px 14px', border: '0.5px dashed var(--separator)', borderRadius: 12, color: 'var(--ink-tertiary)', font: '400 var(--fs-footnote)/1.5 var(--font-text)', textAlign: 'center' }}>
          No skills on this project yet. Search below to add one — or the agent will add what it needs during a run, and it’ll show up here.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Icon name="search" size={14} style={{ position: 'absolute', left: 11, top: 10, color: 'var(--ink-tertiary)' }} />
          <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void search(); }} placeholder="Search available skills"
            style={{ width: '100%', height: 34, padding: '0 11px 0 31px', borderRadius: 9, border: '1px solid var(--hairline)', background: 'var(--surface)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', outline: 'none' }} />
        </div>
        <button onClick={() => void search()} disabled={busy === '__search'} style={{ height: 34, padding: '0 12px', borderRadius: 9, border: 'none', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>{busy === '__search' ? 'Searching' : 'Search'}</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {results.map(s => {
          const installedAlready = installedIds.has(s.id);
          const disabled = s.enabled === false;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 11, border: '0.5px solid var(--separator)', background: 'var(--surface)', opacity: disabled ? 0.72 : 1 }}>
              <span style={{ width: 7, height: 7, borderRadius: 4, background: disabled ? 'var(--red, #e5484d)' : riskTint(s.risk), marginTop: 7, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <span style={{ font: '600 var(--fs-footnote)/1.25 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                  <span style={{ font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)', whiteSpace: 'nowrap' }}>{s.sourceRepo || s.mirrorRepo || s.id.split('/').slice(0, 2).join('/')}</span>
                </span>
                <span style={{ display: 'block', marginTop: 3, font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>{disabled ? `Disabled${s.disabledReason ? `: ${s.disabledReason}` : ''}` : s.description}</span>
              </span>
              <button onClick={() => void add(s)} disabled={disabled || installedAlready || busy === s.id}
                style={{ flexShrink: 0, height: 28, padding: '0 10px', borderRadius: 7, border: 'none', background: installedAlready || disabled ? 'var(--fill-tertiary)' : 'var(--blue)', color: installedAlready || disabled ? 'var(--ink-tertiary)' : '#fff', font: '600 var(--fs-caption)/1 var(--font-text)', cursor: installedAlready || disabled ? 'default' : 'pointer' }}>
                {disabled ? 'Blocked' : installedAlready ? 'Added' : busy === s.id ? 'Adding' : 'Add'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 30 }}>
      <span style={{ width: 92, flexShrink: 0, font: '400 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-tertiary)' }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink)' }}>{children}</span>
    </div>
  );
}

const settingsInput: React.CSSProperties = { width: '100%', border: '1px solid var(--hairline)', borderRadius: 8, padding: '6px 10px', background: 'var(--surface)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', outline: 'none' };

function SettingsBody({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }) {
  const globsText = (project.copyGlobs ?? []).join(', ');
  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Name"><input defaultValue={project.name} key={project.id} onBlur={e => { const v = e.target.value.trim(); if (v && v !== project.name) patch({ name: v }); }} style={settingsInput} /></Field>
      <Field label="Type"><span style={{ textTransform: 'capitalize' }}>{project.kind ?? 'general'}</span></Field>
      {project.path && <Field label="Folder">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <code style={{ flex: 1, minWidth: 0, font: '400 var(--fs-caption)/1.4 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.path}</code>
          <button onClick={() => void api.revealPath(project.path!)} title="Reveal in Finder" style={{ flexShrink: 0, height: 26, padding: '0 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--surface)', color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>Reveal</button>
        </span>
      </Field>}
      {project.repoUrl && <Field label="Repository"><code style={{ font: '400 var(--fs-caption)/1.4 var(--font-mono)', color: 'var(--ink-secondary)' }}>{project.repoUrl}</code></Field>}

      {project.path && <>
        <div style={{ marginTop: 6, paddingTop: 14, borderTop: '0.5px solid var(--separator)', display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Worktree isolation</div>
          <div style={{ font: '400 var(--fs-caption)/1.45 var(--font-text)', color: 'var(--ink-tertiary)' }}>
            Each session runs in its own git worktree. These control how a new worktree is set up and whether sessions can run their dev server in parallel.
          </div>
        </div>
        <Field label="Default branch">
          <input defaultValue={project.defaultBaseBranch ?? ''} key={project.id + ':base'} placeholder="auto-detect (origin/HEAD)"
            onBlur={e => { const v = e.target.value.trim(); if (v !== (project.defaultBaseBranch ?? '')) patch({ defaultBaseBranch: v }); }} style={settingsInput} />
        </Field>
        <Field label="Run mode">
          <select value={project.runMode ?? 'concurrent'} onChange={e => patch({ runMode: e.target.value === 'nonconcurrent' ? 'nonconcurrent' : 'concurrent' })} style={{ ...settingsInput, cursor: 'pointer' }}>
            <option value="concurrent">Concurrent — sessions run in parallel (own MOCHI_PORT each)</option>
            <option value="nonconcurrent">One at a time — shared port / DB / Docker stack</option>
          </select>
        </Field>
        <Field label="Files to copy">
          <input defaultValue={globsText} key={project.id + ':globs'} placeholder=".env*, config/*.local.json"
            onBlur={e => { const next = e.target.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean); if (next.join(',') !== (project.copyGlobs ?? []).join(',')) patch({ copyGlobs: next }); }} style={settingsInput} />
        </Field>
        <div style={{ marginTop: -6, marginLeft: 104, font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>
          Gitignored files copied into each new worktree. A committed <code style={{ font: '400 var(--fs-caption)/1 var(--font-mono)' }}>.worktreeinclude</code> at the repo root overrides this. Default <code style={{ font: '400 var(--fs-caption)/1 var(--font-mono)' }}>.env*</code>.
        </div>
        <Field label="Setup script">
          <input defaultValue={project.setupScript ?? ''} key={project.id + ':setup'} placeholder="pnpm install"
            onBlur={e => { const v = e.target.value.trim(); if (v !== (project.setupScript ?? '')) patch({ setupScript: v }); }} style={settingsInput} />
        </Field>
      </>}
    </div>
  );
}

function InstructionsBody({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }) {
  const [val, setVal] = React.useState(project.instructions ?? '');
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => { setVal(project.instructions ?? ''); }, [project.id]);
  const onChange = (v: string) => {
    setVal(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => patch({ instructions: v }), 600);
  };
  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
        Standing instructions the agent <strong>always</strong> sees for this project — conventions, gotchas, what to remember. Saved automatically.
      </div>
      <textarea value={val} onChange={e => onChange(e.target.value)} placeholder="e.g. This project uses pnpm. Always run the type-check before finishing. The deploy script is ./scripts/deploy.sh…"
        style={{ flex: 1, minHeight: 240, resize: 'vertical', border: '1px solid var(--hairline)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1.6 var(--font-text)', outline: 'none' }} />
    </div>
  );
}

function MemoryBody({ projectId }: { projectId: string }) {
  const [mem, setMem] = React.useState<ProjectMemory | null>(null);
  const [state, setState] = React.useState('');
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    let on = true;
    api.getProjectMemory(projectId).then(m => { if (!on) return; setMem(m); setState(m.state); }).catch(() => { if (on) setMem({ state: '', checkpoints: [] }); });
    return () => { on = false; };
  }, [projectId]);
  const onChange = (v: string) => { setState(v); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void api.setProjectMemory(projectId, v).catch(() => {}), 700); };
  if (!mem) return <div style={{ color: 'var(--ink-tertiary)', font: '400 var(--fs-footnote)/1 var(--font-text)' }}>Loading…</div>;
  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14, height: '100%' }}>
      <div style={{ font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
        The project’s <strong>durable memory</strong> (<code>.continuum/STATE.md</code>) — loaded into every chat so the agent never re-learns this project. The agent keeps it current as it works; you can edit it directly. Shared across coding & design.
      </div>
      <textarea value={state} onChange={e => onChange(e.target.value)} placeholder="Empty for now. The agent will record decisions, structure, conventions and open threads here as it works — or write what it should always remember."
        style={{ minHeight: 200, resize: 'vertical', border: '1px solid var(--hairline)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1.6 var(--font-mono)', outline: 'none' }} />
      {mem.checkpoints.length > 0 && (
        <div>
          <div style={{ font: '700 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)', margin: '4px 0 8px' }}>Checkpoints</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {mem.checkpoints.map(c => (
              <div key={c.id} style={{ padding: '9px 12px', borderRadius: 10, border: '0.5px solid var(--separator)', background: 'var(--surface)' }}>
                <span style={{ font: '700 var(--fs-caption)/1 var(--font-mono)', color: 'var(--blue)' }}>#{c.id}</span>
                <span style={{ marginLeft: 8, font: '400 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>{c.summary.slice(0, 280)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WhatsAppBody({ projectId }: { projectId: string }) {
  const [assigned, setAssigned] = React.useState<string[] | null>(null);
  const [chats, setChats] = React.useState<WaChat[]>([]);
  const [blocked, setBlocked] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const [q, setQ] = React.useState('');

  const reload = React.useCallback(() => {
    api.listProjectWaChats(projectId).then(setAssigned).catch((e: unknown) => { if (e instanceof ApiError && e.status === 403) setBlocked(true); setAssigned([]); });
    api.waListChats().then(setChats).catch(() => {});
  }, [projectId]);
  React.useEffect(reload, [reload]);

  const nameOf = (id: string) => chats.find(c => c.chatId === id)?.name ?? id;
  const add = (id: string) => { void api.addProjectWaChat(projectId, id).then(setAssigned).catch(() => {}); setPicking(false); setQ(''); };
  const remove = (id: string) => { void api.removeProjectWaChat(projectId, id).then(setAssigned).catch(() => {}); };

  if (blocked) return <div style={{ color: 'var(--ink-tertiary)', font: '400 var(--fs-footnote)/1.5 var(--font-text)' }}>Link your WhatsApp number in <b style={{ color: 'var(--ink)' }}>Comms</b> to assign chats to this project.</div>;
  if (!assigned) return <div style={{ color: 'var(--ink-tertiary)', font: '400 var(--fs-footnote)/1 var(--font-text)' }}>Loading…</div>;

  const candidates = chats.filter(c => !assigned.includes(c.chatId) && (!q.trim() || (c.name + ' ' + c.lastMessageText).toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, font: '400 var(--fs-footnote)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
        Chats assigned here are tracked for this project: incoming messages route to it, a chat that goes quiet is summarized to you, and the agent prefers these chats. Read & reply to any chat in the <b style={{ color: 'var(--ink)' }}>WhatsApp</b> space.
      </p>

      {assigned.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', borderRadius: 12, border: '0.5px dashed var(--separator-strong)', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>No WhatsApp chats assigned yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {assigned.map(id => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)' }}>
              <span style={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--green) 16%, transparent)', color: 'var(--green)' }}><Icon name="whatsapp" size={16} /></span>
              <span style={{ flex: 1, minWidth: 0, font: '600 var(--fs-callout)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nameOf(id)}</span>
              <button onClick={() => remove(id)} style={{ height: 30, padding: '0 12px', borderRadius: 8, background: 'transparent', color: 'var(--red)', font: '600 var(--fs-caption)/1 var(--font-text)' }}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {picking ? (
        <div style={{ borderRadius: 12, border: '0.5px solid var(--separator)', background: 'var(--bg-elevated)', overflow: 'hidden' }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats to add"
            style={{ width: '100%', height: 40, padding: '0 14px', boxSizing: 'border-box', border: 'none', borderBottom: '0.5px solid var(--separator)', background: 'transparent', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)' }} />
          <div style={{ maxHeight: 240, overflow: 'auto' }}>
            {candidates.length === 0 ? <div style={{ padding: 14, font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>{chats.length ? 'No more chats to add.' : 'No chats synced yet.'}</div>
              : candidates.slice(0, 50).map(c => (
                <button key={c.chatId} onClick={() => add(c.chatId)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', textAlign: 'left', borderBottom: '0.5px solid color-mix(in srgb, var(--separator) 50%, transparent)' }}>
                  <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.2 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name} <span style={{ color: 'var(--ink-tertiary)' }}>· {c.kind}</span></span>
                  <Icon name="plus" size={15} style={{ color: 'var(--green)' }} />
                </button>
              ))}
          </div>
          <button onClick={() => { setPicking(false); setQ(''); }} style={{ width: '100%', height: 36, background: 'transparent', color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)', borderTop: '0.5px solid var(--separator)' }}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setPicking(true)} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 7, height: 38, padding: '0 16px', borderRadius: 'var(--r-pill)', background: 'var(--green)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)' }}><Icon name="plus" size={16} /> Assign a chat</button>
      )}
    </div>
  );
}

function JobsBody({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = React.useState<Job[] | null>(null);
  React.useEffect(() => { let on = true; api.listJobs(projectId).then(j => { if (on) setJobs(j); }).catch(() => { if (on) setJobs([]); }); return () => { on = false; }; }, [projectId]);
  if (!jobs) return <div style={{ color: 'var(--ink-tertiary)', font: '400 var(--fs-footnote)/1 var(--font-text)' }}>Loading…</div>;
  if (!jobs.length) return <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--ink-tertiary)', font: '400 var(--fs-footnote)/1.5 var(--font-text)' }}>No jobs yet for this project.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {jobs.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(j => (
        <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 12px', borderRadius: 10, border: '0.5px solid var(--separator)', background: 'var(--surface)' }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: STATUS_TINT[j.status] ?? 'var(--ink-tertiary)' }} />
          <span style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.title || j.input?.slice(0, 80) || 'Job'}</span>
          <span style={{ flexShrink: 0, textTransform: 'capitalize', font: '500 var(--fs-caption)/1 var(--font-text)', color: STATUS_TINT[j.status] ?? 'var(--ink-tertiary)' }}>{j.status.replace('_', ' ')}</span>
          {j.cost > 0 && <span style={{ flexShrink: 0, font: '500 var(--fs-caption)/1 var(--font-mono)', color: 'var(--ink-tertiary)' }}>${j.cost.toFixed(2)}</span>}
          <span style={{ flexShrink: 0, font: '400 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)', minWidth: 56, textAlign: 'right' }}>{relTime(j.updatedAt)}</span>
        </div>
      ))}
    </div>
  );
}
