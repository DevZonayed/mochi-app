/* Notification category preferences. The Settings toggles write here; the Activity
   feed (Notifications screen) reads here to filter which events it shows. Persisted
   via storage so the choice survives restarts. */

import type { AppEventKind } from './api';
import { getJSON, setJSON, NOTIF_PREFS } from './storage';

export interface NotifCategory { key: string; label: string; kinds: AppEventKind[] }

/** User-facing categories, each mapped to the real AppEvent kinds it covers. */
export const NOTIF_CATEGORIES: NotifCategory[] = [
  { key: 'gates', label: 'Gates', kinds: ['approval-created', 'approval-resolved'] },
  { key: 'completions', label: 'Completions', kinds: ['job-done', 'clone-done'] },
  { key: 'failures', label: 'Failures', kinds: ['job-failed', 'clone-failed', 'job-cancelled'] },
  { key: 'media', label: 'Media', kinds: ['asset'] },
];

export type NotifPrefs = Record<string, boolean>;

/** Current prefs, defaulting every category to ON. */
export function getNotifPrefs(): NotifPrefs {
  const stored = getJSON<NotifPrefs>(NOTIF_PREFS, {});
  const out: NotifPrefs = {};
  for (const c of NOTIF_CATEGORIES) out[c.key] = stored[c.key] ?? true;
  return out;
}

export function setNotifPref(key: string, val: boolean): NotifPrefs {
  const next = { ...getNotifPrefs(), [key]: val };
  setJSON(NOTIF_PREFS, next);
  return next;
}

const COVERED = new Set<AppEventKind>(NOTIF_CATEGORIES.flatMap((c) => c.kinds));

/** Whether an event passes the current filter. Kinds not covered by any category
    (research, comm) are not user-filterable and always show. */
export function eventAllowed(kind: AppEventKind): boolean {
  if (!COVERED.has(kind)) return true;
  const prefs = getNotifPrefs();
  for (const c of NOTIF_CATEGORIES) {
    if (c.kinds.includes(kind)) return !!prefs[c.key];
  }
  return true;
}
