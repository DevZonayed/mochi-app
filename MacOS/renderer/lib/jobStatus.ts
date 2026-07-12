/* One source of truth for "what does a Job's status MEAN for the UI".

   Kept dependency-free (only the Job/JobStatus types) so every activity
   selector — the session pill (useSessionRunning), the composer control
   derivation (sessionActivity), the transcript merge (turnState) — agrees on
   exactly which jobs count as "the agent is working right now". */

import type { Job, JobStatus } from './api';

/** done/failed/cancelled — the job is finished and will emit no more frames. */
export function isTerminalStatus(status: JobStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** The fields liveness depends on — a Job, or any test double shaped like one. */
export type LiveJob = Pick<Job, 'status' | 'pausedUntil'>;

/** Is this job an ACTIVE agent run right now? running/pending AND not parked on
    a ScheduleWakeup (a paused job's SDK iterator is dormant — it presents as
    "auto-resumes later", not "working"). This is the ONLY definition of
    "session activity"; nothing else (background processes, the selected
    transcript turn, the latest turn) may stand in for it. */
export function isLiveRun(j: LiveJob): boolean {
  if (j.status !== 'running' && j.status !== 'pending') return false;
  if (j.pausedUntil && j.pausedUntil > Date.now()) return false;
  return true;
}
