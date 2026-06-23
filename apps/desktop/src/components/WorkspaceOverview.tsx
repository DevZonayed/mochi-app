/* WorkspaceOverview — "what across all my projects needs attention right now."

   A compact strip that lives at the top of the workspace sidebar (above the
   regular projects list). Reads the live aggregator hook, renders one row
   per project that has at least one non-clean session, sorted by urgency
   (conflicts → mergeable → blocked → ready-for-pr → push → dirty).

   Click a row → switch to that project + open the session whose state
   earned the row's colour (the hook precomputes `topSessionId`).

   Empty state is intentionally calm — a single muted line — so a quiet
   workspace doesn't shout. The strip itself stays mounted (collapsible).

   Accessibility:
   • Wrapper is role="region" with aria-label so a screen-reader can jump.
   • Each row is a <button> with an aria-label that names the project +
     state breakdown + invites a click ("Click to open").
   • The collapse chevron toggles aria-expanded on the strip body.

   No animation noise — this is glanceable, not flashy. */

import React from 'react';
import { Icon } from '../lib/icons';
import { SessionStateDot } from '../screens/SessionStateDot';
import { SESSION_STATE_COLOR, SESSION_STATE_LABELS } from '../lib/git-types';
import type { SessionGitState } from '../lib/git-types';
import {
  useWorkspaceOverview,
  type WorkspaceOverviewHook,
} from '../hooks/useWorkspaceOverview';
import {
  rowAriaLabel,
  emptyStateMessage,
  type OverviewRow,
} from '../lib/workspace-overview';

export interface WorkspaceOverviewProps {
  /** Called when the user clicks a row. Caller is responsible for switching
      the active project + opening the session. */
  onOpenSession: (projectId: string, sessionId: string) => void;
  /** Optional: override the live hook. Useful for tests/preview surfaces. */
  data?: WorkspaceOverviewHook;
}

const STRIP_CSS = `
  .wso-strip { border-bottom: 0.5px solid var(--separator); }
  .wso-head { display: flex; align-items: center; gap: 7px; padding: 9px 12px 8px; user-select: none; }
  .wso-head-btn { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; cursor: pointer; }
  .wso-title { font: 600 var(--fs-footnote)/1.2 var(--font-text); color: var(--ink); white-space: nowrap; }
  .wso-stat { font: 500 var(--fs-caption)/1 var(--font-text); color: var(--ink-tertiary); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .wso-mine { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; font: 600 var(--fs-caption)/1 var(--font-text); cursor: pointer; flex-shrink: 0; border: 1px solid transparent; background: var(--fill-secondary); color: var(--ink-secondary); transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }
  .wso-mine.on { background: color-mix(in srgb, var(--blue) 14%, transparent); color: var(--blue); border-color: color-mix(in srgb, var(--blue) 35%, transparent); }
  .wso-body { padding: 2px 6px 8px; display: flex; flex-direction: column; gap: 2px; }
  .wso-row { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; padding: 6px 8px; border-radius: 8px; cursor: pointer; transition: background 120ms ease; min-width: 0; }
  .wso-row:hover { background: var(--fill-tertiary); }
  .wso-row:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
  .wso-name { flex: 1; min-width: 0; font: 600 var(--fs-footnote)/1.2 var(--font-text); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wso-pill { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 7px; border-radius: 999px; font: 600 10.5px/1 var(--font-text); white-space: nowrap; flex-shrink: 0; }
  .wso-pill-num { font-variant-numeric: tabular-nums; }
  .wso-empty { padding: 8px 12px 12px; font: 500 var(--fs-caption)/1.35 var(--font-text); color: var(--ink-tertiary); display: flex; align-items: center; gap: 6px; }
`;

/** A tinted "2 mergeable" pill. Background + foreground both derived from the
    canonical state colour so a glance ties it back to the per-row dot. */
function StatePill({ state, count }: { state: SessionGitState; count: number }) {
  const color = SESSION_STATE_COLOR[state];
  const label = pillLabel(state);
  return (
    <span
      className="wso-pill"
      title={`${count} ${SESSION_STATE_LABELS[state].toLowerCase()}`}
      style={{
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
        border: `0.5px solid color-mix(in srgb, ${color} 35%, transparent)`,
      }}>
      <span className="wso-pill-num">{count}</span>
      <span>{label}</span>
    </span>
  );
}

/* Pill text is intentionally shorter than the full state label — the colour
   does most of the work and rows are narrow. */
function pillLabel(state: SessionGitState): string {
  switch (state) {
    case 'pr-conflicts': return 'conflicts';
    case 'pr-mergeable': return 'mergeable';
    case 'pr-blocked': return 'blocked';
    case 'ready-for-pr': return 'ready';
    case 'ready-to-push': return 'push';
    case 'uncommitted': return 'dirty';
    case 'pr-merged': return 'merged';
    case 'pr-closed': return 'closed';
    case 'clean': return 'clean';
    case 'no-repo': return '—';
  }
}

/** Tooltip body: per-session breakdown, newest first. Pre-formatted as a
    single string so the native browser tooltip (title=) works without any
    custom popover library. */
function rowTooltip(row: OverviewRow): string {
  const lines: string[] = [];
  for (const s of row.sessions.slice(0, 8)) {
    lines.push(`${SESSION_STATE_LABELS[s.state]} · ${s.title}`);
  }
  if (row.sessions.length > 8) lines.push(`+${row.sessions.length - 8} more`);
  return lines.join('\n');
}

export function WorkspaceOverview({ onOpenSession, data }: WorkspaceOverviewProps) {
  // The hook is the default data source; `data` allows preview/storybook /
  // tests to inject a deterministic snapshot.
  const live = useWorkspaceOverview();
  const view = data ?? live;
  const { rows, totalProjects, attentionProjects, onlyMine, setOnlyMine, collapsed, setCollapsed } = view;

  const bodyId = React.useId();

  // Aggregate stat header: "5 projects · 2 need attention" — concise so it
  // doesn't compete with the projects list below for visual weight.
  const headerStat = `${totalProjects} project${totalProjects === 1 ? '' : 's'} · ${attentionProjects} need${attentionProjects === 1 ? 's' : ''} attention`;

  return (
    <section
      className="wso-strip"
      role="region"
      aria-label="Workspace status">
      <style>{STRIP_CSS}</style>
      <div className="wso-head">
        <button
          type="button"
          className="wso-head-btn"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed(!collapsed)}
          style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--ink)' }}>
          <Icon
            name="chevronRight"
            size={12}
            style={{
              color: 'var(--ink-tertiary)',
              flexShrink: 0,
              transform: collapsed ? 'none' : 'rotate(90deg)',
              transition: 'transform 160ms var(--spring)',
            }} />
          <span className="wso-title">Workspace</span>
          <span className="wso-stat" title={headerStat}>{headerStat}</span>
        </button>
        <button
          type="button"
          className={onlyMine ? 'wso-mine on' : 'wso-mine'}
          onClick={() => setOnlyMine(!onlyMine)}
          aria-pressed={onlyMine}
          title={onlyMine ? 'Showing only projects touched in the last 7 days' : 'Showing every project with attention items'}>
          only mine
        </button>
      </div>

      {!collapsed && (
        <div id={bodyId} className="wso-body">
          {rows.length === 0 ? (
            <div className="wso-empty">
              {totalProjects === 0
                ? <span>{emptyStateMessage(0)}</span>
                : <><Icon name="check" size={12} style={{ color: 'var(--green)', flexShrink: 0 }} /><span>{emptyStateMessage(totalProjects)}</span></>}
            </div>
          ) : (
            rows.map(row => (
              <button
                key={row.projectId}
                type="button"
                className="wso-row"
                aria-label={rowAriaLabel(row)}
                title={rowTooltip(row)}
                onClick={() => onOpenSession(row.projectId, row.topSessionId)}
                style={{ background: 'transparent', border: 'none' }}>
                <SessionStateDot state={row.topState} size={9} />
                <span aria-hidden="true" style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                  background: row.projectColor ? `color-mix(in srgb, var(--${row.projectColor}) 22%, transparent)` : 'var(--fill-secondary)',
                  color: row.projectColor ? `var(--${row.projectColor})` : 'var(--ink-secondary)',
                  font: '700 10px/1 var(--font-text)',
                }}>
                  {(row.projectName.trim()[0] ?? '?').toUpperCase()}
                </span>
                <span className="wso-name">{row.projectName}</span>
                {row.pills.map(p => <StatePill key={p.state} state={p.state} count={p.count} />)}
              </button>
            ))
          )}
        </div>
      )}
    </section>
  );
}

export default WorkspaceOverview;
