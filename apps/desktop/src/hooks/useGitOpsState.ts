/* useGitOpsState — the selector behind <GitOpsDock />. Reads the live
   SessionGitStatus from the shared cache (useSessionGitState) and folds it
   into the one shape the dock cares about: the current state, the primary
   action, the set of "all actions" the expanded dock surfaces, and labels.

   Why a hook (not derive-in-component): the dock is the SOURCE OF TRUTH for
   git actions. Two render surfaces (collapsed pill, expanded sheet) and
   future surfaces (cmd-K palette, T7's "Continue from here") will all read
   the same mapping. Centralizing it here means every surface stays in sync
   when we add states (e.g. T8's AI-resolve flow becomes a distinct action),
   and unit-tests can assert state → primary directly without rendering. */

import * as React from 'react';
import { api } from '../lib/api';
import { useSessionGitState } from '../lib/useSessionGitState';
import type { SessionGitState, SessionGitStatus } from '../lib/git-types';
import { SESSION_STATE_LABELS } from '../lib/git-types';

/** Identity of a dock action. The dock decides labels + icons; handlers run
    against `api.*` so the agent path (gitService) and operator path go
    through the SAME server-side codepath + the same confirm gating. */
export type GitOpsActionKind =
  | 'commit'      // open the commit composer (renderer-owned)
  | 'push'        // api.pushSession
  | 'create-pr'   // api.createSessionPR
  | 'merge'       // api.mergeSessionPR
  | 'resolve'     // api.resolveSession (AI flow is T8's job — stub here)
  | 'open-pr'     // window.open(pr.url)
  | 'continue'    // T7 will wire — no-op stub
  | 'view-diff'   // open existing diff viewer (currently transcript-side)
  | 'rename-branch'
  | 'archive';

/** A single dock action button — pure data, render-agnostic. */
export interface GitOpsAction {
  kind: GitOpsActionKind;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  /** Destructive actions get the confirm dialog (delete branch, merge, etc.). */
  destructive: boolean;
  /** Confirmation copy shown in the confirm dialog. */
  confirm?: string;
  /** Success/ok toast text. */
  okText?: string;
  /** True when the action requires a connected GitHub account with repo scope. */
  needsGitHub: boolean;
  /** True when the action isn't actionable yet (e.g. T7-pending Continue stub). */
  stub?: boolean;
}

/** Pure: map a state to its complete action list. The FIRST entry is the
    primary action surfaced collapsed; the rest appear in the expanded dock. */
export function actionsFor(state: SessionGitState): GitOpsAction[] {
  switch (state) {
    case 'no-repo':
    case 'clean':
    case 'pr-closed':
      return [];
    case 'uncommitted':
      return [
        { kind: 'commit',     label: 'Commit…',         tone: 'primary', destructive: false, needsGitHub: false },
        { kind: 'view-diff',  label: 'View diff',       tone: 'neutral', destructive: false, needsGitHub: false },
      ];
    case 'ready-to-push':
      return [
        { kind: 'push',       label: 'Push',            tone: 'primary', destructive: false, needsGitHub: false, confirm: 'Push this branch to the remote?', okText: 'Pushed' },
        { kind: 'view-diff',  label: 'View diff',       tone: 'neutral', destructive: false, needsGitHub: false },
      ];
    case 'ready-for-pr':
      return [
        { kind: 'create-pr',  label: 'Open PR…',        tone: 'primary', destructive: false, needsGitHub: true, confirm: 'Push the branch and open a pull request on GitHub?', okText: 'PR opened' },
        { kind: 'push',       label: 'Push only',       tone: 'neutral', destructive: false, needsGitHub: false, confirm: 'Push this branch to the remote?', okText: 'Pushed' },
        { kind: 'view-diff',  label: 'View diff',       tone: 'neutral', destructive: false, needsGitHub: false },
      ];
    case 'pr-mergeable':
      return [
        { kind: 'merge',      label: 'Merge',           tone: 'primary', destructive: true,  needsGitHub: true, confirm: 'Merge this pull request on GitHub? This is destructive — the base branch will receive these commits.', okText: 'Merged' },
        { kind: 'open-pr',    label: 'Open PR on GitHub ↗', tone: 'neutral', destructive: false, needsGitHub: false },
        { kind: 'view-diff',  label: 'View diff',       tone: 'neutral', destructive: false, needsGitHub: false },
      ];
    case 'pr-conflicts':
      return [
        // T8 will swap this for an AI flow; for now route the existing resolve handler through the confirm dialog.
        { kind: 'resolve',    label: 'Resolve with AI', tone: 'danger',  destructive: true,  needsGitHub: false, confirm: 'Merge the base branch in to start resolving conflicts? This updates your worktree.', okText: 'Resolve started' },
        { kind: 'open-pr',    label: 'Open PR on GitHub ↗', tone: 'neutral', destructive: false, needsGitHub: false },
        { kind: 'view-diff',  label: 'View diff',       tone: 'neutral', destructive: false, needsGitHub: false },
      ];
    case 'pr-blocked':
      return [
        { kind: 'open-pr',    label: 'Open PR ↗',       tone: 'primary', destructive: false, needsGitHub: false },
        { kind: 'view-diff',  label: 'View diff',       tone: 'neutral', destructive: false, needsGitHub: false },
      ];
    case 'pr-merged':
      // T7 wires this — surfaced as a styled-correctly no-op until then.
      return [
        { kind: 'continue',   label: 'Continue from here →', tone: 'primary', destructive: false, needsGitHub: false, stub: true },
        { kind: 'open-pr',    label: 'Open PR on GitHub ↗', tone: 'neutral', destructive: false, needsGitHub: false },
        { kind: 'archive',    label: 'Archive worktree',    tone: 'neutral', destructive: true,  needsGitHub: false, confirm: 'Remove this session’s worktree from disk?', okText: 'Archived' },
      ];
  }
}

/** Plain-English label for the collapsed pill. Re-exports the existing map
    so the pill stays in sync with every other badge surface in the app. */
export function labelFor(state: SessionGitState): string { return SESSION_STATE_LABELS[state]; }

export interface GitOpsState {
  /** Live status from the shared cache, or `null` while loading. */
  status: SessionGitStatus | null;
  state: SessionGitState | null;
  /** The first entry in `actions` — what the collapsed pill button shows. */
  primary: GitOpsAction | null;
  actions: GitOpsAction[];
  /** Plain-English label for the pill ("Uncommitted", "PR conflicts", …). */
  label: string;
  /** True iff the dock should render at all. `no-repo` + null session → false. */
  visible: boolean;
}

/** The dock's primary read hook. Pure projection over the existing cache;
    no extra subscriptions or fetches. */
export function useGitOpsState(sessionId: string | null | undefined): GitOpsState {
  const status = useSessionGitState(sessionId);
  return React.useMemo(() => {
    const state = status?.state ?? null;
    const actions = state ? actionsFor(state) : [];
    return {
      status,
      state,
      primary: actions[0] ?? null,
      actions,
      label: state ? labelFor(state) : '',
      visible: !!status && status.state !== 'no-repo',
    };
  }, [status]);
}

/** Run a dock action against the api. The dock owns the toast/dialog UI;
    this just maps the action kind → the right server call. Returns a
    `{ ok, reason? }` shape mirroring the existing pushSession / mergeSessionPR
    contract so the dock can render the same feedback semantics. */
export async function runGitOpsAction(
  action: GitOpsAction,
  status: SessionGitStatus | null,
  opts?: { onCommit?: () => void; onContinue?: () => void; onViewDiff?: () => void },
): Promise<{ ok: boolean; reason?: string; data?: unknown }> {
  if (!status) return { ok: false, reason: 'no session status' };
  const sid = status.sessionId;
  switch (action.kind) {
    case 'commit': {
      // The dock opens its own composer (renderer-owned); the actual
      // `git commit` happens via the agent (no IPC commit method on master).
      opts?.onCommit?.();
      return { ok: true };
    }
    case 'push':       return api.pushSession(sid);
    case 'create-pr':  return api.createSessionPR(sid);
    case 'merge':      return api.mergeSessionPR(sid);
    case 'resolve': {
      const r = await api.resolveSession(sid);
      return { ok: r.ok, reason: r.conflicts?.length ? `Conflicts remain: ${r.conflicts.join(', ')}` : r.reason };
    }
    case 'open-pr': {
      if (status.pr?.url) window.open(status.pr.url, '_blank');
      return { ok: true };
    }
    case 'continue': {
      opts?.onContinue?.(); // T7 — no-op stub today
      return { ok: true };
    }
    case 'view-diff': {
      opts?.onViewDiff?.();
      return { ok: true };
    }
    case 'rename-branch': {
      const r = await api.renameSessionBranch(sid);
      return { ok: r.ok, reason: r.reason };
    }
    case 'archive':    return api.archiveSessionWorktree(sid);
  }
}
