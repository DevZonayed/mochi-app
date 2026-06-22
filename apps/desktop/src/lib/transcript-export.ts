/* Plain-text transcript export — the text behind "Copy concise transcript" and
   "Copy full transcript" (the chat tab's context menu, à la Conductor).

   Two faithful renderings of a chat's turns:
   - concise: the conversational spine — your prompts + the assistant's replies —
     with tool calls collapsed to one summary line each (no outputs, no thinking,
     no timings). Readable; small enough to paste into another agent.
   - full:    everything the transcript holds — thinking, every tool call with its
     raw command / file preview / status / duration, image paths. Faithful, large.

   Pure + DOM-free so it unit-tests cleanly and can be reused outside Workspace. */

import type { Job, TranscriptItem } from './api';
import { isSkillTool, prettySkillName, toolDisplay } from './toolDisplay';

export type TranscriptMode = 'concise' | 'full';

/* ── small string helpers ─────────────────────────────────────────────── */

/** First non-empty line, trimmed and capped with an ellipsis — for one-liners. */
function firstLine(s: string, cap: number): string {
  const line = (s || '').split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  return line.length > cap ? line.slice(0, cap - 1).trimEnd() + '…' : line;
}

/** Basename of a path-ish string (the chip the UI shows for file tools). */
function basename(p: string): string {
  const s = (p || '').trim().replace(/\/+$/, '');
  return s.split('/').pop() || s;
}

/** Indent every non-blank line — for nested previews / multi-line commands. */
function indent(s: string, pad = '    '): string {
  return (s || '').split('\n').map(l => (l ? pad + l : l)).join('\n');
}

/** Tool duration, mirroring the chat UI's fmtToolDur. */
function fmtDur(ms?: number): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/* ── per-item rendering ───────────────────────────────────────────────── */

/** One tool item → a `↳ …` block. Concise: a single summary line (label + target,
    short raw command). Full: + status, duration, multi-line command, file preview. */
function toolBlock(it: TranscriptItem, mode: TranscriptMode): string {
  const name = it.name ?? '';
  if (isSkillTool(name)) return `↳ Skill: ${prettySkillName(it.text || '')}`.trimEnd();

  const d = toolDisplay(name);
  let detail = (it.text || '').trim();
  if (d.file && detail) detail = mode === 'concise' ? basename(detail) : detail; // path → filename

  // Avoid "Run Run tests": when the detail already opens with the verb, drop the label.
  const startsWithVerb = !!detail && detail.toLowerCase().startsWith(d.short.toLowerCase());
  let head = startsWithVerb ? `↳ ${detail}` : `↳ ${d.short}${detail ? ` ${detail}` : ''}`;

  const cmd = (it.cmd || '').trim();
  const cmdInline = !!cmd && !cmd.includes('\n');
  if (cmd && (mode === 'concise' || cmdInline)) head += `: ${mode === 'concise' ? firstLine(cmd, 100) : cmd}`;

  if (mode === 'full') {
    const meta: string[] = [];
    if (it.toolStatus === 'error') meta.push('error');
    else if (it.toolStatus === 'running') meta.push('running');
    const dur = fmtDur(it.durMs);
    if (dur) meta.push(dur);
    if (meta.length) head += `  (${meta.join(', ')})`;
  }

  const lines = [head];
  if (mode === 'full' && cmd && cmd.includes('\n')) lines.push(indent(cmd));
  if (mode === 'full' && it.preview && it.preview.trim()) lines.push(indent(it.preview.trimEnd()));
  return lines.join('\n');
}

/** A transcript item → its segment text (or '' to skip), tagged tool/not for spacing. */
function itemSegment(it: TranscriptItem, mode: TranscriptMode): { tool: boolean; text: string } | null {
  switch (it.kind) {
    case 'text':
    case 'result': {
      const t = (it.text || '').trim();
      return t ? { tool: false, text: t } : null;
    }
    case 'thinking': {
      const t = (it.text || '').trim();
      return mode === 'full' && t ? { tool: false, text: `[thinking]\n${t}` } : null;
    }
    case 'tool':
      return { tool: true, text: toolBlock(it, mode) };
    case 'review': {
      const verdict = it.verdict ?? 'note';
      const tag = it.resolved ? `${verdict}, resolved` : verdict;
      const t = (it.text || '').trim();
      const body = mode === 'concise' ? firstLine(t, 200) : t;
      return { tool: false, text: `[review: ${tag}]${body ? `\n${body}` : ''}` };
    }
    case 'ask': {
      const q = (it.ask || it.text || '').trim();
      return { tool: false, text: `[question]${q ? ` ${q}` : ''}` };
    }
    case 'image': {
      const detail = mode === 'full' ? (it.imagePath || it.alt || '') : '';
      return { tool: false, text: detail ? `[image: ${detail}]` : '[image]' };
    }
    default:
      return null;
  }
}

/** The assistant side of one turn — its transcript items, or the plain output when
    there is no structured transcript. Consecutive tool lines stay tight; prose is
    separated by a blank line. */
function assistantBody(job: Job, mode: TranscriptMode): string {
  const items = job.transcript ?? [];
  if (items.length === 0) return (job.output || '').trim();

  const segs = items.map(it => itemSegment(it, mode)).filter((s): s is { tool: boolean; text: string } => !!s && !!s.text);
  let out = '';
  for (let i = 0; i < segs.length; i++) {
    if (i > 0) out += segs[i].tool && segs[i - 1].tool ? '\n' : '\n\n';
    out += segs[i].text;
  }
  return out;
}

/** The user side of one turn — the prompt plus any attachment placeholders. */
function userBody(job: Job, mode: TranscriptMode): string {
  const lines: string[] = [];
  const text = (job.input || '').trim();
  if (text) lines.push(text);
  for (const img of job.inputImages ?? []) {
    lines.push(mode === 'full' && img.imagePath ? `[image: ${img.imagePath}]` : `[image${img.name ? `: ${img.name}` : ''}]`);
  }
  for (const f of job.inputFiles ?? []) lines.push(`[file: ${f.name}]`);
  return lines.join('\n');
}

/* ── public entry point ───────────────────────────────────────────────── */

/** Render a chat's turns as a plain-text/Markdown transcript for the clipboard. */
export function formatTranscript(jobs: Job[], opts: { mode: TranscriptMode; title?: string }): string {
  const { mode } = opts;
  const title = (opts.title || '').trim() || 'Transcript';
  const turns = [...jobs].sort((a, b) => a.createdAt - b.createdAt);

  const parts: string[] = [
    `# ${title}\n_${mode === 'concise' ? 'Concise' : 'Full'} transcript · ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}_`,
  ];
  for (const job of turns) {
    parts.push(`## User\n${userBody(job, mode) || '_(no message)_'}`);
    const body = assistantBody(job, mode).trim();
    parts.push(`## Assistant\n${body || '_(no response)_'}`);
  }
  return parts.join('\n\n') + '\n';
}
