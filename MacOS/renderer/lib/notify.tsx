/* Device notifications — a configurable chime when an agent finishes a response
   or a chat needs attention. Sounds are synthesised with the Web Audio API (no
   audio files to bundle, works offline, identical on desktop & web). The prefs
   live in AppSettings so they follow the operator across surfaces; this module
   is the single in-renderer source of truth (mirrors the theme store pattern).

   <NotificationCenter/> is mounted once at the app root: it watches the global
   job/approval event stream and rings the right chime, respecting every pref. */

import React from 'react';
import { api, type JobStatus, type NotificationSettings, type NotificationSound } from './api';

export type { NotificationSound, NotificationSettings };

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  onComplete: true,
  completeSound: 'chime',
  onAttention: true,
  attentionSound: 'ping',
  volume: 0.7,
  onlyWhenUnfocused: false,
};

/* ─────────────────────────── sound synthesis ─────────────────────────── */

interface Note { freq: number; at: number; dur: number; type?: OscillatorType; peak?: number }

/** Each sound is a short sequence of enveloped oscillator notes. Tuned to be
    pleasant, distinct, and brief — a device cue, not a melody. */
const RECIPES: Record<Exclude<NotificationSound, 'none'>, Note[]> = {
  // Two-note rising chime — the "done" default. Warm and conclusive.
  chime:   [{ freq: 880, at: 0, dur: 0.2, type: 'sine' }, { freq: 1318.5, at: 0.11, dur: 0.42, type: 'sine' }],
  // Single bright ping — the "attention" default. Cuts through.
  ping:    [{ freq: 1568, at: 0, dur: 0.34, type: 'triangle', peak: 0.9 }],
  // Three-note marimba arpeggio — playful, unmistakable.
  marimba: [{ freq: 659.3, at: 0, dur: 0.16, type: 'triangle' }, { freq: 880, at: 0.1, dur: 0.16, type: 'triangle' }, { freq: 1318.5, at: 0.2, dur: 0.34, type: 'triangle' }],
  // Soft glassy bell — two stacked sines that shimmer and fade.
  glass:   [{ freq: 1046.5, at: 0, dur: 0.6, type: 'sine', peak: 0.7 }, { freq: 1568, at: 0.015, dur: 0.55, type: 'sine', peak: 0.35 }],
  // Quick pop — the most minimal, least intrusive option.
  pop:     [{ freq: 523.25, at: 0, dur: 0.09, type: 'sine' }, { freq: 784, at: 0.05, dur: 0.13, type: 'sine' }],
};

export const SOUND_OPTIONS: { value: NotificationSound; label: string }[] = [
  { value: 'chime', label: 'Chime' },
  { value: 'ping', label: 'Ping' },
  { value: 'marimba', label: 'Marimba' },
  { value: 'glass', label: 'Glass' },
  { value: 'pop', label: 'Pop' },
  { value: 'none', label: 'None (silent)' },
];

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    // Browsers may start the context suspended until a user gesture; resume on
    // the first interaction so background chimes can play thereafter.
    const resume = () => { void ctx?.resume(); };
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function playNote(ac: AudioContext, master: GainNode, n: Note): void {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = n.type ?? 'sine';
  osc.frequency.value = n.freq;
  const t0 = ac.currentTime + n.at;
  const peak = n.peak ?? 1;
  // Fast attack, exponential decay — a clean bell-like envelope.
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.dur);
  osc.connect(g); g.connect(master);
  osc.start(t0);
  osc.stop(t0 + n.dur + 0.05);
}

/** Play a notification sound at the given volume (0–1). No-op when silent. */
export function playSound(sound: NotificationSound, volume = 0.7): void {
  if (sound === 'none' || volume <= 0) return;
  const recipe = RECIPES[sound];
  if (!recipe) return;
  const ac = audioCtx();
  if (!ac) return;
  const master = ac.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.4; // headroom so stacked notes don't clip
  master.connect(ac.destination);
  for (const n of recipe) playNote(ac, master, n);
}

/* ─────────────────────── shared settings store ───────────────────────── */

let cache: NotificationSettings = { ...DEFAULT_NOTIFICATIONS };
let loadStarted = false;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

export function getNotificationSettings(): NotificationSettings { return cache; }

/** Fetch the persisted prefs once and seed the cache (idempotent). */
export async function loadNotificationSettings(): Promise<void> {
  if (loadStarted) return;
  loadStarted = true;
  try {
    const s = await api.getSettings();
    cache = { ...DEFAULT_NOTIFICATIONS, ...(s.notifications ?? {}) };
    emit();
  } catch { /* keep defaults on failure */ }
}

/** Patch the prefs — updates the cache (live for the listener) and persists. */
export function updateNotificationSettings(patch: Partial<NotificationSettings>): void {
  cache = { ...cache, ...patch };
  emit();
  void api.setSettings({ notifications: cache }).catch(() => {});
}

/** React hook: current prefs, kept in sync across the Settings pane + center. */
export function useNotificationSettings(): NotificationSettings {
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    listeners.add(force);
    void loadNotificationSettings();
    return () => { listeners.delete(force); };
  }, []);
  return cache;
}

/* ──────────────────────── the global listener ────────────────────────── */

/** Mounted once at the app root. Rings the configured chime when a response
    finishes (a job reaches `done`) or a chat needs attention (a pending
    approval appears, or a job fails). Seeds from a live snapshot so it never
    fires for work that completed before the app opened. */
export function NotificationCenter() {
  React.useEffect(() => {
    void loadNotificationSettings();

    const lastStatus = new Map<string, JobStatus>();
    const seenApprovals = new Set<string>();
    let primed = false;

    Promise.all([
      api.listJobs().catch(() => []),
      api.listApprovals('pending').catch(() => []),
    ]).then(([jobs, approvals]) => {
      for (const j of jobs) lastStatus.set(j.id, j.status);
      for (const a of approvals) seenApprovals.add(a.id);
      primed = true;
    });

    const ring = (kind: 'complete' | 'attention') => {
      const s = getNotificationSettings();
      if (!s.enabled) return;
      if (kind === 'complete' ? !s.onComplete : !s.onAttention) return;
      if (s.onlyWhenUnfocused && typeof document !== 'undefined' && document.hasFocus()) return;
      playSound(kind === 'complete' ? s.completeSound : s.attentionSound, s.volume);
    };

    const unsub = api.subscribe({
      onJob: (job) => {
        const prev = lastStatus.get(job.id);
        lastStatus.set(job.id, job.status);
        if (!primed || prev === job.status) return;
        if (job.status === 'done' && (prev === 'running' || prev === 'pending')) ring('complete');
        else if (job.status === 'failed' && prev !== 'failed') ring('attention');
      },
      onApproval: (a) => {
        if (a.status !== 'pending' || seenApprovals.has(a.id)) return;
        seenApprovals.add(a.id);
        if (primed) ring('attention');
      },
    });
    return () => unsub();
  }, []);
  return null;
}
