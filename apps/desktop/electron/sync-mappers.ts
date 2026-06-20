/* Pure helpers that translate the desktop's domain shapes (ChatSession + Job)
   into the SyncWorker's wire shape (SyncChat + SyncMessage[]). Pulled out of
   main.ts so the mapping logic can be unit-tested without spinning up an
   Electron app. */

import type { ChatSession, Job } from './store.js';
import type { SyncChat, SyncMessage } from './sync-worker.js';

/** Map a ChatSession to the mirror's wire shape. We don't ship internal
    things like sdkSessionId, branch, worktreePath — those are mac-only. */
export function chatSessionToSync(s: ChatSession): SyncChat {
  return {
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    // `archived` on disk is a ms timestamp or undefined; the wire uses a
    // simple boolean (when the value lands, we know it's archived).
    archived: !!s.archived,
    updatedAt: s.updatedAt,
  };
}

/** Map one Job to the mirror's messages. A job represents one chat turn —
    a user message (input) + an assistant message (output, when present).
    Ids are deterministic so a re-emit (e.g. on output update) overwrites
    the previous content rather than dup-ing the row. */
export function jobToSyncMessages(job: Job): SyncMessage[] {
  if (!job.sessionId) return []; // not a chat turn (a one-off job — won't show in chat history)
  const out: SyncMessage[] = [];
  const baseMeta = {
    jobId: job.id,
    status: job.status,
    effort: job.effort,
    engine: job.engine,
    model: job.model,
  } as Record<string, unknown>;
  // Always emit the user side — input never changes during a run.
  out.push({
    id: `${job.id}:in`,
    chatId: job.sessionId,
    role: 'user',
    content: job.input,
    createdAt: job.createdAt,
    metadata: { ...baseMeta, kind: 'input' },
  });
  // Assistant side: emit when the output is non-empty, OR when the job has
  // already failed (so the phone sees the failure message). For still-running
  // jobs we wait — the streaming token loop will call us again with the
  // final string.
  if (job.output || job.status === 'failed' || job.status === 'done') {
    out.push({
      id: `${job.id}:out`,
      chatId: job.sessionId,
      role: 'assistant',
      content: job.output ?? (job.error ? `(failed) ${job.error}` : ''),
      createdAt: job.updatedAt,
      metadata: { ...baseMeta, kind: 'output' },
    });
  }
  return out;
}
