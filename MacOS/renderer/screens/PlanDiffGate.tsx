import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '../lib/appShell';
import { api, type Approval, type Project } from '../lib/api';
import { Icon } from '../lib/icons';
import { Spinner } from '../lib/ui';

const styles = `
  .primary-cta { transition: transform 120ms var(--spring), box-shadow 160ms ease, background 140ms ease; }
  .primary-cta:hover { box-shadow: 0 8px 22px rgba(0,122,255,0.4); }
  .primary-cta:active { transform: translateY(1px); }
  .ghost-btn:hover { background: color-mix(in srgb, var(--fill-secondary) 60%, var(--ink) 7%); }
  .reject-btn:hover { background: rgba(255,59,48,0.1); }
`;

function fmtWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'Created time unavailable';
  return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function projectLabel(project: Project | null, approval: Approval): string {
  if (project?.name) return project.name;
  return approval.projectId ? 'Project unavailable' : 'Workspace';
}

function EmptyState() {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 32 }}>
      <div style={{ maxWidth: 460, textAlign: 'center', color: 'var(--ink-secondary)' }}>
        <h1 style={{ margin: '0 0 8px', font: '700 var(--fs-title1)/1.15 var(--font-display)', color: 'var(--ink)' }}>No plan pending</h1>
        <p style={{ margin: 0, font: '400 var(--fs-body)/1.45 var(--font-text)' }}>There is no approval context to display right now.</p>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 0', borderTop: '0.5px solid var(--separator)' }}>
      <span style={{ width: 92, flexShrink: 0, font: '600 var(--fs-caption)/1 var(--font-text)', letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-tertiary)' }}>{label}</span>
      <span style={{ font: '500 var(--fs-subhead)/1.4 var(--font-text)', color: 'var(--ink)' }}>{value}</span>
    </div>
  );
}

function ApprovalCard({
  approval,
  project,
  busy,
  onBack,
  onApprove,
  onDeny,
}: {
  approval: Approval;
  project: Project | null;
  busy: 'approve' | 'deny' | null;
  onBack: () => void;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const detail = approval.detail || approval.subtitle || '';
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 24px', borderBottom: '0.5px solid var(--separator)', background: 'color-mix(in srgb, var(--bg) 86%, transparent)' }}>
        <button onClick={onBack} className="ghost-btn" aria-label="Back" style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--fill-secondary)', color: 'var(--ink)', flexShrink: 0 }}>
          <Icon name="arrowLeft" size={17} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, font: '500 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink-secondary)', marginBottom: 4 }}>
            <span>{projectLabel(project, approval)}</span>
            <Icon name="chevronRight" size={12} style={{ color: 'var(--ink-tertiary)' }} />
            <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{approval.kind}</span>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 24, padding: '0 11px', borderRadius: 'var(--r-pill)',
            background: 'color-mix(in srgb, var(--orange) 15%, transparent)', color: 'var(--orange)', font: '600 var(--fs-footnote)/1 var(--font-text)' }}>
            <Icon name="enter" size={13} /> {approval.status}
          </span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '28px 24px' }}>
        <section style={{ maxWidth: 720, margin: '0 auto', background: 'var(--bg-elevated)', borderRadius: 18, border: '0.5px solid var(--separator)', boxShadow: 'var(--card-shadow)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '20px 22px', borderBottom: '0.5px solid var(--separator)' }}>
            <span style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)', flexShrink: 0 }}>
              <Icon name="sliders" size={20} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{ margin: 0, font: '700 var(--fs-title1)/1.15 var(--font-display)', color: 'var(--ink)' }}>{approval.title}</h1>
              {detail && <p style={{ margin: '8px 0 0', font: '400 var(--fs-body)/1.45 var(--font-text)', color: 'var(--ink-secondary)', whiteSpace: 'pre-wrap' }}>{detail}</p>}
            </div>
          </div>
          <div style={{ padding: '8px 22px 12px' }}>
            <MetaRow label="Project" value={projectLabel(project, approval)} />
            <MetaRow label="Kind" value={approval.kind} />
            <MetaRow label="Status" value={approval.status} />
            <MetaRow label="Created" value={fmtWhen(approval.createdAt)} />
          </div>
        </section>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 20px', borderTop: '0.5px solid var(--separator)', background: 'var(--bg-elevated)' }}>
        <button disabled={busy !== null} onClick={onApprove} className="primary-cta" style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)', background: 'var(--blue)', color: '#fff', font: '600 var(--fs-callout)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: busy ? 0.72 : 1 }}>
          {busy === 'approve' ? <Spinner size={14} color="#fff" /> : <Icon name="check" size={16} stroke={2.6} />} Approve
        </button>
        <button disabled={busy !== null} onClick={onDeny} className="ghost-btn reject-btn" style={{ height: 42, padding: '0 18px', borderRadius: 'var(--r-pill)', color: 'var(--red)', font: '600 var(--fs-callout)/1 var(--font-text)', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: busy ? 0.72 : 1 }}>
          {busy === 'deny' ? <Spinner size={14} color="var(--red)" /> : <Icon name="x" size={16} stroke={2.4} />} Deny
        </button>
      </div>
    </div>
  );
}

export default function PlanDiffGate() {
  const navigate = useNavigate();
  const [approval, setApproval] = React.useState<Approval | null>(null);
  const [project, setProject] = React.useState<Project | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState<'approve' | 'deny' | null>(null);

  const loadGate = React.useCallback(async () => {
    try {
      const [approvals, projects] = await Promise.all([api.listApprovals('pending'), api.listProjects()]);
      const picked = approvals.find(a => a.kind === 'merge') ?? approvals[0] ?? null;
      setApproval(picked);
      setProject(picked ? projects.find(p => p.id === picked.projectId) ?? null : null);
    } catch {
      setApproval(null);
      setProject(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  React.useEffect(() => { void loadGate(); }, [loadGate]);

  const approve = async () => {
    if (!approval) return;
    setBusy('approve');
    try {
      await api.approveApproval(approval.id);
      await loadGate();
    } finally {
      setBusy(null);
    }
  };

  const deny = async () => {
    if (!approval) return;
    setBusy('deny');
    try {
      await api.denyApproval(approval.id);
      await loadGate();
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell active="approvals" onSearch={() => navigate('/approvals')}>
      <style>{styles}</style>
      {!loaded ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}><Spinner size={18} /></div>
      ) : approval ? (
        <ApprovalCard approval={approval} project={project} busy={busy} onBack={() => navigate('/job-monitor')} onApprove={() => void approve()} onDeny={() => void deny()} />
      ) : (
        <EmptyState />
      )}
    </AppShell>
  );
}
