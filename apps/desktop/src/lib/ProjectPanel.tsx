/* The project hub — a workspace tab for a project's own settings, instructions
   (its persistent memory of how to work), and job history. Opened from the "⋯"
   menu on a project in the tree, so per-project things are one click from the
   workspace instead of buried in a separate screen. */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Project, type Job } from './api';
import { Icon, type IconName } from './icons';

type Section = 'settings' | 'instructions' | 'jobs';

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
  const navigate = useNavigate();
  const [project, setProject] = React.useState<Project | null>(null);
  const [tab, setTab] = React.useState<Section>(section);
  React.useEffect(() => { setTab(section); }, [section]);
  React.useEffect(() => { let on = true; api.getProject(projectId).then(p => { if (on) setProject(p); }).catch(() => {}); return () => { on = false; }; }, [projectId]);

  const patch = (p: Partial<Project>) => { setProject(cur => (cur ? { ...cur, ...p } : cur)); void api.updateProject(projectId, p).catch(() => {}); };

  const TABS: { key: Section; label: string; icon: IconName }[] = [
    { key: 'settings', label: 'Settings', icon: 'settings' },
    { key: 'instructions', label: 'Instructions', icon: 'bookmark' },
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
        {tab === 'settings' && project && <SettingsBody project={project} patch={patch} onFull={() => navigate(`/project-detail/${projectId}`)} />}
        {tab === 'instructions' && project && <InstructionsBody project={project} patch={patch} />}
        {tab === 'jobs' && <JobsBody projectId={projectId} />}
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

function SettingsBody({ project, patch, onFull }: { project: Project; patch: (p: Partial<Project>) => void; onFull: () => void }) {
  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Name"><input defaultValue={project.name} key={project.id} onBlur={e => { const v = e.target.value.trim(); if (v && v !== project.name) patch({ name: v }); }} style={{ width: '100%', border: '1px solid var(--hairline)', borderRadius: 8, padding: '6px 10px', background: 'var(--surface)', color: 'var(--ink)', font: '400 var(--fs-footnote)/1 var(--font-text)', outline: 'none' }} /></Field>
      <Field label="Type"><span style={{ textTransform: 'capitalize' }}>{project.kind ?? 'general'}</span></Field>
      {project.path && <Field label="Folder">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <code style={{ flex: 1, minWidth: 0, font: '400 var(--fs-caption)/1.4 var(--font-mono)', color: 'var(--ink-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.path}</code>
          <button onClick={() => void api.revealPath(project.path!)} title="Reveal in Finder" style={{ flexShrink: 0, height: 26, padding: '0 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--surface)', color: 'var(--ink-secondary)', font: '500 var(--fs-caption)/1 var(--font-text)', cursor: 'pointer' }}>Reveal</button>
        </span>
      </Field>}
      {project.repoUrl && <Field label="Repository"><code style={{ font: '400 var(--fs-caption)/1.4 var(--font-mono)', color: 'var(--ink-secondary)' }}>{project.repoUrl}</code></Field>}
      <button onClick={onFull} style={{ alignSelf: 'flex-start', marginTop: 6, display: 'flex', alignItems: 'center', gap: 7, height: 32, padding: '0 13px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--surface)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>
        <Icon name="arrowRight" size={14} /> Open full project page
      </button>
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
