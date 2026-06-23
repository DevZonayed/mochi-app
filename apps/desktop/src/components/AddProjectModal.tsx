/* <AddProjectModal /> — the in-workspace "add a project" surface that
   replaces the old menu that redirected the user to /projects (a real
   navigation, which broke the user's flow: "everything need to work IN
   workspace, such as codespace or designspace"). Three tabs:

     1. From folder  — native folder picker → createProject (existing flow)
     2. New          — name + parent folder picker → createProject (local-only)
     3. Clone        — owner/repo|URL|SSH → gh repo view preview → cloneRepo

   Renders over a dimmed backdrop with the workspace STILL VISIBLE behind
   (user knows they did not navigate), traps focus, closes on Esc / outside-
   click / Cancel, and on success returns the freshly-created Project to the
   parent so the sidebar entry can appear + auto-expand + toast can fire.

   Accessibility: role=dialog / aria-modal, tablist semantics, labelled
   inputs, aria-live for inline validation + errors. */

import React from 'react';
import { api, type Project, type GithubRepoMetadata } from '../lib/api';
import { Icon } from '../lib/icons';
import {
  type AddProjectTab,
  TABS,
  validateCloneInput,
  validateNewLocalInput,
  buildCloneArgs,
} from '../lib/addProjectForm';
import { planOpenFolder, projectNameFromPath, type OpenFolderPlan } from '../lib/open-folder-flow';

const MODAL_CSS = `
  .apm-tab { transition: background 120ms ease, color 120ms ease; }
  .apm-tab:hover { background: var(--fill-tertiary); }
  .apm-tab[aria-selected="true"] { background: var(--bg-elevated); color: var(--ink); box-shadow: 0 1px 3px rgba(15,20,60,0.08); }
  .apm-input { transition: border-color 120ms ease, box-shadow 120ms ease; }
  .apm-input:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 22%, transparent); }
  .apm-btn { transition: background 120ms ease, color 120ms ease, transform 80ms ease; }
  .apm-btn:hover:not(:disabled) { filter: brightness(1.05); }
  .apm-btn:active:not(:disabled) { transform: translateY(1px); }
  .apm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  @keyframes apm-spin { to { transform: rotate(360deg); } }
  .apm-spin { animation: apm-spin 0.7s linear infinite; }
`;

interface Props {
  open: boolean;
  /** Closes the modal. The parent owns the open/close flag so the same trigger
      that opened it (the "+" button) can stay aligned with the rest of the UI. */
  onClose: () => void;
  /** Called when a project is added (any of the three flows). Parent uses this
      to update its project list + auto-expand the new entry in the sidebar +
      raise a "Project '<name>' added — click to open chat" toast. */
  onAdded: (project: Project) => void;
}

export function AddProjectModal({ open, onClose, onAdded }: Props) {
  const [tab, setTab] = React.useState<AddProjectTab>('folder');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Tab 2 (New local) state — name + chosen parent folder. We DO NOT call
  // the network "New on GitHub" flow because #62's bootstrapProject helper
  // is not on master yet (see the note rendered inside the New tab).
  const [newName, setNewName] = React.useState('');
  const [newParent, setNewParent] = React.useState<string | null>(null);

  // Tab 3 (Clone) state — single text input + chosen parent folder + the
  // gh repo view metadata card (loaded only after the user has typed a
  // parseable owner/repo, so we don't pre-fetch on every keystroke).
  const [cloneText, setCloneText] = React.useState('');
  const [cloneParent, setCloneParent] = React.useState<string | null>(null);
  const [meta, setMeta] = React.useState<GithubRepoMetadata | null>(null);
  const [metaLoading, setMetaLoading] = React.useState(false);
  const [metaError, setMetaError] = React.useState<string | null>(null);

  // Tab 1 (From folder) — after picking, an `adoptFolderInspect` result is
  // turned into an OpenFolderPlan and rendered as an in-modal decision step
  // (not a redirect). `inspecting` is the spinner state between the picker
  // closing and the inspection landing. `pickedPath` is held so the action
  // buttons can re-run bootstrap/createProject without re-prompting.
  const [pickedPath, setPickedPath] = React.useState<string | null>(null);
  const [folderPlan, setFolderPlan] = React.useState<OpenFolderPlan | null>(null);
  const [inspecting, setInspecting] = React.useState(false);

  // Reset transient state every time the modal re-opens (e.g. operator
  // opens it, dismisses with Esc, opens again from a different sidebar).
  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setMeta(null);
    setMetaError(null);
    setMetaLoading(false);
    setPickedPath(null);
    setFolderPlan(null);
    setInspecting(false);
  }, [open]);

  // Esc closes — but only when we're not mid-submit (so the user doesn't
  // accidentally orphan a half-done clone by tapping Escape twice).
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); closeRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  // Focus trap — first focusable input on each tab gets focus when the
  // tab becomes active. Keeps the keyboard flow predictable.
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const el = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]');
      el?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [open, tab]);

  const cloneValidation = validateCloneInput(cloneText, cloneParent);
  const newValidation = validateNewLocalInput(newName, newParent);

  // Debounced metadata fetch when the user pastes a recognisable ref. We
  // don't make it gating — they can clone without the preview card too —
  // but the card is reassuring before the clone actually starts.
  React.useEffect(() => {
    setMeta(null);
    setMetaError(null);
    setMetaLoading(false);
    const ref = cloneValidation.ref;
    if (!ref) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setMetaLoading(true);
      try {
        const m = await api.githubRepoMetadata({ owner: ref.owner, repo: ref.repo });
        if (cancelled) return;
        setMeta(m);
      } catch (e) {
        if (cancelled) return;
        setMetaError(e instanceof Error ? e.message : 'Could not reach GitHub.');
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneValidation.ref?.owner, cloneValidation.ref?.repo]);

  const pickFolder = async (set: (p: string) => void) => {
    try {
      const r = await api.pickFolder();
      if (r?.ok && r.path) set(r.path);
    } catch { /* user cancelled */ }
  };

  /** Pick a folder + run `adoptFolderInspect` so we know which decision
      card to show (silent proceed / create-memory / init+push / no-git).
      We DON'T navigate or create the project yet — the operator confirms
      via the in-modal decision step rendered from `folderPlan`. */
  const submitFromFolder = async () => {
    setError(null); setBusy(true); setFolderPlan(null);
    try {
      const r = await api.pickFolder();
      if (!r || !r.ok || !r.path) { setBusy(false); return; }
      setPickedPath(r.path);
      setInspecting(true);
      setBusy(false);
      // Best-effort: a failing inspect (no IPC, no token, anything) still
      // produces a sensible plan via the fallback below.
      let plan: OpenFolderPlan;
      try {
        const inspect = await api.adoptFolderInspect(r.path);
        plan = planOpenFolder(inspect);
      } catch (e) {
        // No GitHub auth / no electron bridge — treat the local info we DO
        // know (`pickFolder` returned `info: RepoInfo`) as the inspection.
        plan = planOpenFolder({
          ok: true, path: r.path,
          info: r.info,
          remote: r.info.remote,
          kind: !r.info.isRepo ? 'no-git'
            : !r.info.remote ? 'git-no-remote'
            : /github\.com[:/]/i.test(r.info.remote) ? 'git-github'
            : 'git-non-github',
          memoryRepo: { state: 'no-github-auth' },
          error: e instanceof Error ? e.message : undefined,
        });
      }
      setInspecting(false);
      // Silent proceed: no operator decision needed, just open the project.
      if (plan.kind === 'silent-proceed') {
        await runProceed(r.path, plan.proceed);
        return;
      }
      setFolderPlan(plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to inspect folder.');
      setInspecting(false); setBusy(false);
    }
  };

  /** Create the project with whatever GitHub linkage the decision step
      produced (full silent-proceed payload, or the post-bootstrap result).
      Shared by every `From folder` action so the linkage shape stays in
      one place. */
  const runProceed = async (path: string, link: { repoUrl: string; memorySlug: string; memoryRepoUrl: string }) => {
    setBusy(true);
    try {
      const name = projectNameFromPath(path);
      const proj = await api.createProject({
        name, kind: 'coding', path,
        instructions: '', color: 'blue',
        ...(link.repoUrl ? { repoUrl: link.repoUrl } : {}),
        ...(link.memorySlug ? { memorySlug: link.memorySlug } : {}),
        ...(link.memoryRepoUrl ? { memoryRepoUrl: link.memoryRepoUrl } : {}),
      });
      onAdded(proj);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add folder.');
    } finally { setBusy(false); }
  };

  /** "Skip — local-only" / "Skip — keep local" — just register the path
      as-is, no GitHub side effects. Same code path as runProceed with no
      linkage so the project lands in the sidebar identically. */
  const skipFolderPlan = async () => {
    if (!pickedPath) return;
    await runProceed(pickedPath, { repoUrl: '', memorySlug: '', memoryRepoUrl: '' });
  };

  /** "Create GitHub repo + push" (git-no-remote) or "Init + push to GitHub"
      (no-git). The desktop-side bootstrap handles both (it runs `git init`
      only when needed via `adopt`). On 401 we surface a friendly error so
      the operator knows to sign in to GitHub first. */
  const bootstrapFolderToGitHub = async () => {
    if (!pickedPath || !folderPlan) return;
    setError(null); setBusy(true);
    try {
      const name = projectNameFromPath(pickedPath);
      const result = await api.bootstrapProject({
        name, localPath: pickedPath, private: true,
        // adopt:true skips the local `git init` when the folder is already
        // a repo (git-no-remote case). The bootstrap helper still seeds the
        // README/.gitignore/.continuum and runs the initial commit + push.
        adopt: folderPlan.kind === 'git-no-remote',
      });
      // No `owner` passed → legacy single-repo path → `cloneUrl` is on the
      // result. The dual-repo shape only appears when the owner picker fed
      // in a selection (which we don't have in this surface today).
      const repoUrl = 'cloneUrl' in result ? result.cloneUrl : '';
      await runProceed(pickedPath, { repoUrl, memorySlug: '', memoryRepoUrl: '' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Bootstrap failed.';
      // 401 is the most common cause (no GitHub auth). Tell the user how to fix it
      // INSIDE the modal — they shouldn't have to dig through Settings.
      setError(/401|sign in/i.test(msg)
        ? 'Sign in to GitHub first (Settings → GitHub), then try again — or click Skip to keep this folder local-only.'
        : msg);
      setBusy(false);
    }
  };

  /** "Create memory repo" (github-no-memory case). The dual-repo bootstrap
      WITHOUT an owner picker falls back to the single-repo path which won't
      create the memory companion — so we call a tiny adopt flow instead:
      proceed with the known repoUrl + ask the lifecycle to create the
      memory repo on first openProject. The plan already carries the slug
      + user so the createProject call knows the names. */
  const createMemoryAndProceed = async () => {
    if (!pickedPath || !folderPlan || folderPlan.kind !== 'github-no-memory') return;
    // We optimistically wire memorySlug + memoryRepoUrl onto the project —
    // the openProject lifecycle (`openProjectMemory` in project-lifecycle.ts)
    // calls ensureMemoryRepo which CREATES the repo if it doesn't exist yet.
    await runProceed(pickedPath, {
      repoUrl: folderPlan.repoUrl,
      memorySlug: folderPlan.memorySlug,
      memoryRepoUrl: `https://github.com/${folderPlan.memoryUser}/${folderPlan.memorySlug}-memory`,
    });
  };

  const submitNewLocal = async () => {
    if (!newValidation.ok || !newParent) return;
    setError(null); setBusy(true);
    try {
      const safe = newName.trim().replace(/\s+/g, '-');
      const fullPath = `${newParent.replace(/\/+$/, '')}/${safe}`;
      const proj = await api.createProject({ name: newName.trim(), kind: 'coding', path: fullPath, instructions: '', color: 'blue' });
      onAdded(proj);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project.');
    } finally { setBusy(false); }
  };

  const submitClone = async () => {
    if (!cloneValidation.ok || !cloneValidation.ref || !cloneParent) return;
    setError(null); setBusy(true);
    try {
      const args = buildCloneArgs(cloneValidation.ref, cloneParent);
      const proj = await api.cloneRepo(args);
      onAdded(proj);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clone failed.');
    } finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <div
      onClick={() => { if (!busy) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(8,10,30,0.34)', backdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', padding: 20 }}
    >
      <style>{MODAL_CSS}</style>
      <div
        ref={dialogRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="apm-title"
        style={{ width: 'min(540px, 100%)', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', background: 'var(--bg-elevated)', border: '0.5px solid var(--separator)', borderRadius: 16, boxShadow: 'var(--shadow-lg, 0 24px 70px rgba(15,20,60,0.32))' }}
      >
        {/* ── header ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 20px 8px' }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)' }}>
            <Icon name="plus" size={18} stroke={2.4} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="apm-title" style={{ margin: 0, font: '700 var(--fs-headline)/1.2 var(--font-display)', color: 'var(--ink)' }}>Add a project</h2>
            <p style={{ margin: '2px 0 0', font: '400 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>Stays right here in the workspace — no navigation.</p>
          </div>
          <button
            onClick={() => { if (!busy) onClose(); }}
            title="Close"
            aria-label="Close"
            disabled={busy}
            className="apm-btn"
            style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'transparent', color: 'var(--ink-tertiary)', cursor: 'pointer' }}
          ><Icon name="x" size={16} stroke={2.4} /></button>
        </div>

        {/* ── tablist ── */}
        <div
          role="tablist"
          aria-label="Add project method"
          style={{ display: 'flex', gap: 4, padding: '6px 20px 6px', borderBottom: '0.5px solid var(--separator)' }}
        >
          {TABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`apm-panel-${t.id}`}
              id={`apm-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className="apm-tab"
              style={{ flex: 1, padding: '8px 10px', borderRadius: 9, background: 'transparent', color: tab === t.id ? 'var(--ink)' : 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1.2 var(--font-text)', cursor: 'pointer', textAlign: 'center' }}
            >{t.label}</button>
          ))}
        </div>

        {/* ── panels ── */}
        <div style={{ padding: '18px 20px 20px', minHeight: 220 }}>
          {tab === 'folder' && (
            <div role="tabpanel" id="apm-panel-folder" aria-labelledby="apm-tab-folder" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ margin: 0, font: '400 var(--fs-subhead)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
                Pick a folder on your Mac — it becomes a coding project and stays in your workspace.
              </p>

              {/* Step 1: pick. Hidden once we have a plan to show. */}
              {!folderPlan && !inspecting && (
                <>
                  <button
                    data-autofocus
                    onClick={submitFromFolder}
                    disabled={busy}
                    className="apm-btn"
                    style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 16px', borderRadius: 10, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}
                  >
                    {busy ? <span className="apm-spin" style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.5)', borderTopColor: '#fff' }} /> : <Icon name="folder" size={15} />}
                    Pick folder…
                  </button>
                  <div style={{ font: '400 var(--fs-caption)/1.4 var(--font-text)', color: 'var(--ink-tertiary)' }}>
                    Existing repos are detected automatically — git status will light up the sidebar.
                  </div>
                </>
              )}

              {/* Inspecting spinner — between picker close and plan landing. */}
              {inspecting && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 10, background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)' }}>
                  <span className="apm-spin" style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--separator)', borderTopColor: 'var(--blue)' }} />
                  <span style={{ font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
                    Inspecting {pickedPath ? projectNameFromPath(pickedPath) : 'folder'}…
                  </span>
                </div>
              )}

              {/* Step 2: the decision step. Renders 1–2 action buttons based
                  on what `planOpenFolder` resolved — the default-focused
                  button (data-autofocus) is the recommendation per the spec. */}
              {folderPlan && (
                <FolderDecision
                  plan={folderPlan}
                  busy={busy}
                  onInitPush={bootstrapFolderToGitHub}
                  onCreateMemory={createMemoryAndProceed}
                  onSkip={skipFolderPlan}
                  onPickAnother={() => { setFolderPlan(null); setPickedPath(null); setError(null); }}
                />
              )}
            </div>
          )}

          {tab === 'new' && (
            <div role="tabpanel" id="apm-panel-new" aria-labelledby="apm-tab-new" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="apm-new-name" style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Project name</label>
                <input
                  id="apm-new-name"
                  data-autofocus
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="my-side-project"
                  className="apm-input"
                  style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--separator)', background: 'var(--bg-base)', font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Parent folder</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0, height: 36, display: 'flex', alignItems: 'center', padding: '0 12px', borderRadius: 10, border: '1px solid var(--separator)', background: 'var(--fill-secondary)', font: '500 var(--fs-footnote)/1 var(--font-text)', color: newParent ? 'var(--ink)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {newParent ?? 'No folder picked yet'}
                  </div>
                  <button onClick={() => pickFolder(setNewParent)} disabled={busy} className="apm-btn"
                    style={{ height: 36, padding: '0 14px', borderRadius: 10, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer', border: '1px solid var(--separator)' }}>
                    {newParent ? 'Change…' : 'Choose…'}
                  </button>
                </div>
              </div>
              <div style={{ padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--blue) 6%, transparent)', border: '0.5px solid color-mix(in srgb, var(--blue) 24%, transparent)', font: '400 var(--fs-caption)/1.5 var(--font-text)', color: 'var(--ink-secondary)' }}>
                Creates a local-only project at <code>parent/name</code>. GitHub auto-create coming soon via #62.
              </div>
              <div aria-live="polite" style={{ minHeight: 18, font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--red, #ff3b30)' }}>
                {newValidation.reason ?? ''}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={onClose} disabled={busy} className="apm-btn"
                  style={{ height: 36, padding: '0 16px', borderRadius: 10, background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={submitNewLocal} disabled={busy || !newValidation.ok} className="apm-btn"
                  style={{ height: 36, padding: '0 16px', borderRadius: 10, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {busy && <span className="apm-spin" style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.5)', borderTopColor: '#fff' }} />}
                  Create project
                </button>
              </div>
            </div>
          )}

          {tab === 'clone' && (
            <div role="tabpanel" id="apm-panel-clone" aria-labelledby="apm-tab-clone" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="apm-clone-input" style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Repository</label>
                <input
                  id="apm-clone-input"
                  data-autofocus
                  value={cloneText}
                  onChange={e => setCloneText(e.target.value)}
                  placeholder="owner/repo  ·  https://github.com/…  ·  git@github.com:…"
                  className="apm-input"
                  style={{ height: 36, padding: '0 12px', borderRadius: 10, border: '1px solid var(--separator)', background: 'var(--bg-base)', font: '500 var(--fs-subhead)/1 var(--font-text)', color: 'var(--ink)' }}
                />
              </div>

              {/* Preview card — appears only after we have a recognisable ref */}
              {cloneValidation.ref && (
                <div style={{ padding: '12px 14px', borderRadius: 12, border: '0.5px solid var(--separator)', background: 'var(--fill-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {metaLoading && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--ink-secondary)' }}>
                      <span className="apm-spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--separator)', borderTopColor: 'var(--ink-secondary)' }} />
                      Looking up {cloneValidation.ref.owner}/{cloneValidation.ref.repo}…
                    </div>
                  )}
                  {meta && !metaLoading && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name={meta.isPrivate ? 'lock' : 'globe'} size={14} style={{ color: meta.isPrivate ? 'var(--orange, #ff9500)' : 'var(--green, #34c759)' }} />
                        <span style={{ font: '700 var(--fs-subhead)/1.2 var(--font-text)', color: 'var(--ink)' }}>{meta.fullName}</span>
                        <span style={{ marginLeft: 'auto', font: '500 var(--fs-caption)/1 var(--font-text)', color: 'var(--ink-tertiary)' }}>default: {meta.defaultBranch}</span>
                      </div>
                      {meta.description && (
                        <div style={{ font: '400 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--ink-secondary)' }}>{meta.description}</div>
                      )}
                    </>
                  )}
                  {metaError && !metaLoading && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, font: '500 var(--fs-footnote)/1.3 var(--font-text)', color: 'var(--red, #ff3b30)' }}>
                      <Icon name="alert" size={14} />
                      {metaError}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ font: '600 var(--fs-footnote)/1 var(--font-text)', color: 'var(--ink)' }}>Local destination</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0, height: 36, display: 'flex', alignItems: 'center', padding: '0 12px', borderRadius: 10, border: '1px solid var(--separator)', background: 'var(--fill-secondary)', font: '500 var(--fs-footnote)/1 var(--font-text)', color: cloneParent ? 'var(--ink)' : 'var(--ink-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {cloneParent ? `${cloneParent}${cloneValidation.ref ? `/${cloneValidation.ref.repo}` : ''}` : 'No folder picked yet'}
                  </div>
                  <button onClick={() => pickFolder(setCloneParent)} disabled={busy} className="apm-btn"
                    style={{ height: 36, padding: '0 14px', borderRadius: 10, background: 'var(--fill-secondary)', color: 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer', border: '1px solid var(--separator)' }}>
                    {cloneParent ? 'Change…' : 'Choose…'}
                  </button>
                </div>
              </div>

              <div aria-live="polite" style={{ minHeight: 18, font: '500 var(--fs-caption)/1.3 var(--font-text)', color: 'var(--red, #ff3b30)' }}>
                {cloneValidation.reason ?? ''}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={onClose} disabled={busy} className="apm-btn"
                  style={{ height: 36, padding: '0 16px', borderRadius: 10, background: 'transparent', color: 'var(--ink-secondary)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Cancel</button>
                <button onClick={submitClone} disabled={busy || !cloneValidation.ok} className="apm-btn"
                  style={{ height: 36, padding: '0 16px', borderRadius: 10, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {busy && <span className="apm-spin" style={{ width: 13, height: 13, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.5)', borderTopColor: '#fff' }} />}
                  Clone
                </button>
              </div>
            </div>
          )}

          {/* Submit-time error (shared across tabs). Lives below the panel
              so it doesn't reflow the tab content while typing. */}
          {error && (
            <div role="alert" style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--red, #ff3b30) 8%, transparent)', border: '0.5px solid color-mix(in srgb, var(--red, #ff3b30) 28%, transparent)', font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red, #ff3b30)' }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* FolderDecision — renders the "what should we do with this folder?" card
   the modal shows after a successful adoptFolderInspect (Bug 1). Each
   branch lays out ONE primary recommendation (default-focused, the user
   can hit Enter) + a secondary Skip button per the spec. The plan's
   `recommended` field picks which button gets data-autofocus. */
function FolderDecision({ plan, busy, onInitPush, onCreateMemory, onSkip, onPickAnother }: {
  plan: OpenFolderPlan;
  busy: boolean;
  onInitPush: () => void;
  onCreateMemory: () => void;
  onSkip: () => void;
  onPickAnother: () => void;
}) {
  if (plan.kind === 'error') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div role="alert" style={{ padding: '10px 12px', borderRadius: 10, background: 'color-mix(in srgb, var(--red, #ff3b30) 8%, transparent)', border: '0.5px solid color-mix(in srgb, var(--red, #ff3b30) 28%, transparent)', font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--red, #ff3b30)' }}>{plan.error}</div>
        <div><button data-autofocus onClick={onPickAnother} className="apm-btn" style={{ height: 36, padding: '0 16px', borderRadius: 10, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>Pick another folder…</button></div>
      </div>
    );
  }
  // silent-proceed is handled by submitFromFolder directly — it shouldn't
  // ever reach this render path. Defensive fallback shows "ready" with one
  // primary button to keep the operator unblocked even if the flow regresses.
  if (plan.kind === 'silent-proceed') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ font: '500 var(--fs-footnote)/1.4 var(--font-text)', color: 'var(--ink-secondary)' }}>{plan.headline}</div>
      </div>
    );
  }
  const headline = plan.headline;
  const initPushLabel = plan.kind === 'no-git' ? 'Init + push to GitHub' : 'Create GitHub repo + push';
  const skipLabel = plan.kind === 'no-git' ? 'Skip — keep local' : 'Skip — local-only';
  const showCreateMemory = plan.kind === 'github-no-memory';
  const showInitPush = plan.kind === 'no-git' || plan.kind === 'git-no-remote';
  const recommended = plan.recommended;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '14px 16px', borderRadius: 12, background: 'var(--fill-secondary)', border: '0.5px solid var(--separator)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{ width: 24, height: 24, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in srgb, var(--blue) 14%, transparent)', color: 'var(--blue)' }}>
          <Icon name={plan.kind === 'no-git' ? 'folder' : 'gitBranch'} size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0, font: '500 var(--fs-footnote)/1.45 var(--font-text)', color: 'var(--ink)' }}>{headline}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onPickAnother} disabled={busy} className="apm-btn"
          style={{ height: 36, padding: '0 14px', borderRadius: 10, background: 'transparent', color: 'var(--ink-tertiary)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer' }}>
          Pick another
        </button>
        <button
          {...(recommended === 'skip' ? { 'data-autofocus': true } : {})}
          onClick={onSkip} disabled={busy} className="apm-btn"
          style={{ height: 36, padding: '0 14px', borderRadius: 10, background: recommended === 'skip' ? 'var(--blue)' : 'var(--fill-tertiary)', color: recommended === 'skip' ? '#fff' : 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer', border: '1px solid var(--separator)' }}>
          {skipLabel}
        </button>
        {showInitPush && (
          <button
            {...(recommended === 'init-push' ? { 'data-autofocus': true } : {})}
            onClick={onInitPush} disabled={busy} className="apm-btn"
            style={{ height: 36, padding: '0 16px', borderRadius: 10, background: recommended === 'init-push' ? 'var(--blue)' : 'var(--fill-tertiary)', color: recommended === 'init-push' ? '#fff' : 'var(--ink)', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer', border: '1px solid var(--separator)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            {busy && <span className="apm-spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.5)', borderTopColor: '#fff' }} />}
            {initPushLabel}
          </button>
        )}
        {showCreateMemory && (
          <button
            {...(recommended === 'create-memory' ? { 'data-autofocus': true } : {})}
            onClick={onCreateMemory} disabled={busy} className="apm-btn"
            style={{ height: 36, padding: '0 16px', borderRadius: 10, background: 'var(--blue)', color: '#fff', font: '600 var(--fs-footnote)/1 var(--font-text)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            {busy && <span className="apm-spin" style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.5)', borderTopColor: '#fff' }} />}
            Create memory repo
          </button>
        )}
      </div>
    </div>
  );
}
