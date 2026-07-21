import type { Job, Schedule } from './api.js';

export interface QuestionProjection {
  bySourceJobId: Map<string, Schedule>;
  hidden: Schedule[];
  legacy: Schedule[];
}

export function projectPendingQuestions(schedules: Schedule[], turns: Pick<Job, 'id'>[], sessionId?: string | null): QuestionProjection {
  const visibleTurnIds = new Set(turns.map((turn) => turn.id));
  const bySourceJobId = new Map<string, Schedule>();
  const hidden: Schedule[] = [];
  const legacy: Schedule[] = [];
  if (!sessionId) return { bySourceJobId, hidden, legacy };
  for (const schedule of schedules) {
    if (schedule.kind !== 'auto-answer' || schedule.sessionId !== sessionId || !schedule.enabled) continue;
    const sourceJobId = typeof schedule.sourceJobId === 'string' ? schedule.sourceJobId.trim() : '';
    if (!sourceJobId) {
      legacy.push(schedule);
      continue;
    }
    if (visibleTurnIds.has(sourceJobId)) {
      bySourceJobId.set(sourceJobId, schedule);
    } else {
      hidden.push(schedule);
    }
  }
  return { bySourceJobId, hidden, legacy };
}
