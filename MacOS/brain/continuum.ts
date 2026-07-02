/* Per-project persistent memory — Maestro's take on the mochi .continuum: a
   living STATE.md plus an append-only chain of dated "link" summaries (decisions,
   deltas, open threads). Read into every run as context so the agent never
   re-learns a project; updated by the agent (STATE) + automatically per turn
   (a chain link). Lives at <projectRoot>/.continuum, shared by every genre. */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const STATE_CAP = 16_000;
const LINK_CAP = 8_000;

function dir(projectRoot: string): string { return path.join(projectRoot, '.continuum'); }
function linksDir(projectRoot: string): string { return path.join(dir(projectRoot), 'chain', 'links'); }
function linkIds(projectRoot: string): number[] {
  const d = linksDir(projectRoot);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter(n => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
}

/** STATE.md + the last K link summaries, formatted for injection at run start.
    '' when the project has no memory yet (so callers can skip the preamble). */
export function readContinuumContext(projectRoot: string, k = 4): string {
  try {
    const root = dir(projectRoot);
    if (!existsSync(root)) return '';
    const parts: string[] = [];
    const statePath = path.join(root, 'STATE.md');
    if (existsSync(statePath)) { const s = readFileSync(statePath, 'utf8').trim(); if (s) parts.push(`STATE.md (the project's durable memory):\n${s.length > STATE_CAP ? s.slice(0, STATE_CAP) + '\n…(truncated — STATE.md exceeds the cap; consider compacting it)' : s}`); }
    const ids = linkIds(projectRoot).slice(-k).reverse();
    const links: string[] = [];
    for (const id of ids) {
      const f = path.join(linksDir(projectRoot), String(id).padStart(4, '0'), 'summary.md');
      if (existsSync(f)) links.push(`• Link ${id}: ${readFileSync(f, 'utf8').trim().slice(0, 1200)}`);
    }
    if (links.length) parts.push(`Recent checkpoints (newest first):\n${links.join('\n')}`);
    return parts.join('\n\n').trim();
  } catch { return ''; }
}

/** Replace STATE.md — the agent's durable understanding of the project. */
export function writeProjectState(projectRoot: string, state: string): void {
  try { mkdirSync(dir(projectRoot), { recursive: true }); writeFileSync(path.join(dir(projectRoot), 'STATE.md'), (state ?? '').slice(0, STATE_CAP), 'utf8'); } catch { /* best effort */ }
}
export function readProjectState(projectRoot: string): string {
  try { const f = path.join(dir(projectRoot), 'STATE.md'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; } catch { return ''; }
}

/** Append a chain link (a checkpoint) + index entry. */
export function appendCheckpoint(projectRoot: string, input: { summary: string; tags?: string[]; commit?: string }, atMs: number): { id: number } {
  const ld = linksDir(projectRoot);
  mkdirSync(ld, { recursive: true });
  const id = (linkIds(projectRoot).pop() ?? 0) + 1;
  const linkDir = path.join(ld, String(id).padStart(4, '0'));
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(path.join(linkDir, 'summary.md'), (input.summary ?? '').slice(0, LINK_CAP), 'utf8');
  try {
    appendFileSync(path.join(dir(projectRoot), 'chain', 'index.jsonl'),
      JSON.stringify({ id, ts: new Date(atMs).toISOString(), tags: input.tags ?? [], commit: input.commit ?? null }) + '\n');
  } catch { /* index is advisory */ }
  return { id };
}

/** The chain links as {id, summary}, newest first — for the UI memory view. */
export function listCheckpoints(projectRoot: string, limit = 50): { id: number; summary: string }[] {
  return linkIds(projectRoot).slice(-limit).reverse().map(id => {
    const f = path.join(linksDir(projectRoot), String(id).padStart(4, '0'), 'summary.md');
    let summary = ''; try { if (existsSync(f)) summary = readFileSync(f, 'utf8'); } catch { /* gone */ }
    return { id, summary };
  });
}
