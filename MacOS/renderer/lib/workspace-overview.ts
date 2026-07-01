/* Workspace overview — pure aggregator.

   The sidebar strip and any future "what needs attention" surface read from
   one rollup: for every project that owns AT LEAST ONE non-clean session, we
   emit a row carrying:

   • the project's WORST per-session state (drives the row colour + sort key),
   • a small ordered bag of state→count pills ("2 mergeable, 1 conflicts"),
   • the id of the session that earned the top state (so a click can open the
     most-urgent chat without re-deriving it on the consumer side).

   Sorting is intentional (not just `priorityOf(topState)` desc): we lift
   `pr-conflicts` to the very top (red, blocks merging), then `pr-mergeable`
   (green, one click to ship), `pr-blocked` (red-soft, CI), then the push/PR
   "you have something to do" cluster, then plain dirty. Projects with zero
   non-clean sessions are OMITTED from the strip — the regular projects list
   below still shows them.

   No React, no DOM. The `useWorkspaceOverview` hook turns this into a live
   selector by listening on the shared SessionGitStatus cache. */

import type { ChatSession, Project } from './api';
import type { SessionGitState, SessionGitStatus } from './git-types';
import { SESSION_STATE_LABELS } from './git-types';

/** How the sort sees each state. Higher = listed earlier in the strip.
    Distinct from `STATE_PRIORITY` in git-types (which is "worst wins for
    rollup colour"): here mergeable outranks ready-to-push because a row
    where you can click Merge is more urgent than one where you can click
    Push, and conflicts outrank EVERYTHING — those block your day. */
const ROW_SORT: Record<SessionGitState, number> = {
  'pr-conflicts': 100,
  'pr-mergeable': 90,
  'pr-blocked': 80,
  'ready-for-pr': 70,
  'ready-to-push': 60,
  uncommitted: 50,
  'pr-merged': 10,
  'pr-closed': 5,
  clean: 0,
  'no-repo': -1,
};

/** States that the strip considers "needs attention". `clean`, `no-repo`,
    `pr-merged`, `pr-closed` are nothing-to-do — projects with ONLY these
    states fall off the strip entirely. */
const ATTENTION_STATES = new Set<SessionGitState>([
  'pr-conflicts',
  'pr-mergeable',
  'pr-blocked',
  'ready-for-pr',
  'ready-to-push',
  'uncommitted',
]);

export function needsAttention(state: SessionGitState): boolean {
  return ATTENTION_STATES.has(state);
}

/** Short label used inside the per-row pills. We don't want the full
    "PR · conflicts" form here — pills are tight, multi-pill. */
const PILL_LABEL: Record<SessionGitState, string> = {
  'pr-conflicts': 'conflicts',
  'pr-mergeable': 'mergeable',
  'pr-blocked': 'blocked',
  'ready-for-pr': 'ready for PR',
  'ready-to-push': 'ready to push',
  uncommitted: 'uncommitted',
  'pr-merged': 'merged',
  'pr-closed': 'closed',
  clean: 'clean',
  'no-repo': 'no repo',
};

export interface OverviewPill {
  state: SessionGitState;
  count: number;
  /** e.g. "2 mergeable", "1 conflicts". Singular nouns stay singular — the
      pluralisation is only on the leading number, not the state word, which
      reads like a category not a thing. */
  label: string;
}

export interface OverviewRow {
  projectId: string;
  projectName: string;
  /** CSS color token from the project (matches the sidebar dot). May be
      undefined if the project has no color set; consumer falls back. */
  projectColor: string | undefined;
  /** The single state used to colour the row + the dot. Sort key. */
  topState: SessionGitState;
  /** Session whose state matched `topState` — click-target for the row.
      We pick the most-recently-touched matching session so the click lands
      on a chat the user actually saw recently. */
  topSessionId: string;
  /** Ordered, non-empty pill list. Sorted by state urgency (same order as
      ROW_SORT), capped at 3 to keep rows from going wide. */
  pills: OverviewPill[];
  /** Total non-clean session count behind this row (== sum of pill counts).
      Used by the screen-reader aria-label. */
  attentionCount: number;
  /** All non-clean sessions in this project, newest-first. Used by the
      hover tooltip breakdown. */
  sessions: { sessionId: string; title: string; state: SessionGitState; updatedAt: number }[];
}

export interface AggregateInput {
  projects: Project[];
  sessions: ChatSession[];
  statuses: Map<string, SessionGitStatus>;
  /** When ON, hide rows whose every session was last updated more than
      `freshnessMs` ago. Default ON (matches the strip's [only mine] toggle). */
  onlyMine?: boolean;
  /** Default 7 days. Configurable for tests. */
  freshnessMs?: number;
  /** "Now" for the freshness comparison. Injected for deterministic tests. */
  now?: number;
}

export interface AggregateResult {
  rows: OverviewRow[];
  /** Project count we considered (not the filtered row count). */
  totalProjects: number;
  /** Projects that ended up in `rows` (== rows.length, exposed for the
      "X projects · Y need attention" header without a second derivation). */
  attentionProjects: number;
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function pluralPill(count: number, state: SessionGitState): OverviewPill {
  return { state, count, label: `${count} ${PILL_LABEL[state]}` };
}

/** Pure: roll session statuses up per project, sort by urgency, format pills.
    Tested in workspace-overview.test.ts. */
export function aggregateWorkspaceOverview(input: AggregateInput): AggregateResult {
  const { projects, sessions, statuses } = input;
  const onlyMine = input.onlyMine ?? true;
  const freshnessMs = input.freshnessMs ?? SEVEN_DAYS;
  const now = input.now ?? Date.now();

  // Group sessions by project for O(P + S) total work — building a Map once
  // beats P × find() once you have more than a handful of projects.
  const sessionsByProj = new Map<string, ChatSession[]>();
  for (const s of sessions) {
    if (s.archived) continue; // archived chats don't deserve attention
    const arr = sessionsByProj.get(s.projectId);
    if (arr) arr.push(s); else sessionsByProj.set(s.projectId, [s]);
  }

  const rows: OverviewRow[] = [];

  for (const proj of projects) {
    const projSessions = sessionsByProj.get(proj.id) ?? [];
    if (projSessions.length === 0) continue;

    // Map session → its current state (default 'no-repo' if cache miss; that
    // way an un-fetched session can't masquerade as "clean" — it simply
    // doesn't contribute to attention).
    type Entry = { sessionId: string; title: string; state: SessionGitState; updatedAt: number; provisional: boolean };
    const entries: Entry[] = projSessions.map(s => {
      const st = statuses.get(s.id);
      const state = st?.state ?? 'no-repo';
      // A status computed without a GitHub PR query (`prChecked === false`) can
      // only GUESS the PR-derivable states. The cheap local-only path reports a
      // pushed branch as `ready-for-pr` ("no PR exists — go open one") and a
      // pushed dirty tree as `uncommitted`, but if a PR is actually open/merged
      // the next poll reclassifies it to pr-*/pr-merged and the row vanishes.
      // Treat such an entry as provisional so we don't show a row that's about
      // to disappear; once the poll confirms it (prChecked === true) it surfaces
      // with its real state. Un-pushed sessions can't have a PR, so they're
      // never provisional — their local state is final.
      const provisional = st?.prChecked === false && !!st.local.pushed;
      return { sessionId: s.id, title: s.title, state, updatedAt: s.updatedAt, provisional };
    });

    const attention = entries.filter(e => ATTENTION_STATES.has(e.state) && !e.provisional);
    if (attention.length === 0) continue; // every session clean → off the strip

    if (onlyMine) {
      // Hide if NONE of this project's attention-sessions have been touched
      // recently. Stale projects you abandoned shouldn't shout.
      const cutoff = now - freshnessMs;
      if (!attention.some(e => e.updatedAt >= cutoff)) continue;
    }

    // Pills: one per distinct state, sorted by urgency, capped at 3.
    const counts = new Map<SessionGitState, number>();
    for (const e of attention) counts.set(e.state, (counts.get(e.state) ?? 0) + 1);
    const pillStates = Array.from(counts.keys()).sort((a, b) => ROW_SORT[b] - ROW_SORT[a]);
    const pills: OverviewPill[] = pillStates.slice(0, 3).map(s => pluralPill(counts.get(s)!, s));

    // Top state = first pill (highest urgency present in this project).
    const topState = pillStates[0];

    // Click target: most-recently-touched session that matches the top state.
    // (Ties: stable on session order — ChatSession[] is typically returned
    // newest-first by the API.)
    const topCandidates = attention.filter(e => e.state === topState);
    topCandidates.sort((a, b) => b.updatedAt - a.updatedAt);
    const topSessionId = topCandidates[0].sessionId;

    // Hover tooltip list: every attention session, newest first.
    const sessionsForTooltip = [...attention].sort((a, b) => b.updatedAt - a.updatedAt);

    rows.push({
      projectId: proj.id,
      projectName: proj.name,
      projectColor: proj.color || undefined,
      topState,
      topSessionId,
      pills,
      attentionCount: attention.length,
      sessions: sessionsForTooltip,
    });
  }

  // Inter-row sort: by topState urgency, then by row attentionCount desc
  // (more sessions screaming = higher), then by projectName for stable order.
  rows.sort((a, b) => {
    const ra = ROW_SORT[a.topState];
    const rb = ROW_SORT[b.topState];
    if (ra !== rb) return rb - ra;
    if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
    return a.projectName.localeCompare(b.projectName);
  });

  return { rows, totalProjects: projects.length, attentionProjects: rows.length };
}

/** Empty-state message used by the strip when every project is clean.
    Pure so it tests cleanly. */
export function emptyStateMessage(totalProjects: number): string {
  if (totalProjects === 0) return 'No projects yet';
  if (totalProjects === 1) return 'Everything clean across 1 project';
  return `Everything clean across ${totalProjects} projects`;
}

/** Build the aria-label for a row's button. Keeps the screen-reader copy in
    sync with the visible pills without re-reading the DOM. */
export function rowAriaLabel(row: OverviewRow): string {
  const states = row.pills.map(p => p.label).join(', ');
  const topLabel = SESSION_STATE_LABELS[row.topState];
  return `${row.projectName} · ${states}; top state ${topLabel}. Click to open.`;
}
