/* subagent-routing — pure routing logic for Task/Agent dispatch events.
   Extracted from engine.ts so the children-accumulation contract that #72
   shipped is unit-testable (and the Bug 2 regression — where children
   silently vanished when the SDK emitted sub-agent events before the
   parent's own assistant message — has a real test guarding against it).

   The router is given the parent's transcript map (so it can find the
   right `tool` chip to hang children under) + the SDK's raw message, and
   mutates the matched chip's `children[]`. The CALLER is responsible for
   emitting progress and for advancing past non-subagent events; this
   module ONLY handles `m.parent_tool_use_id`-tagged frames.

   Bug 2 fix: when the parent's tool_use chip isn't registered yet (the
   SDK may emit the sub-agent's first event BEFORE the parent's full
   `assistant` message lands), we BUFFER the events keyed by parentId and
   replay them the moment the parent registers via `attachParent(...)`.
   Without this buffer, the first 1–N sub-agent events were dropped
   silently — leaving `parent.children` empty even though the operator
   saw the sub-agent run to completion. */

import type { TranscriptItem } from './store.js';

/** Per-parent writer state. Mirrors the top-level open-block tracking
    (open text/thinking + a tool_use_id → chip map) but writes into the
    parent's own `children[]` array. */
export interface SubWriter {
  open: TranscriptItem | null;
  openThinking: TranscriptItem | null;
  toolById: Map<string, TranscriptItem>;
}

/** Minimal shape of an SDK message the router cares about. We accept the
    permissive Record<string, unknown> the engine already uses and narrow
    inline — keeps the engine→router boundary loose so a new SDK field
    doesn't break the build. */
export interface SubAgentMessage {
  type?: string;
  parent_tool_use_id?: string | null;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
}

/** Wire signature for the per-tool labeller — `engine.ts` passes its own
    `toolLabel` so we don't duplicate the formatter here. */
export type ToolLabelFn = (name: string, input: unknown, cwd: string) => { text: string; cmd?: string };
/** Optional preview extractor — used by Read/Edit to attach a snippet. */
export type ToolPreviewFn = (name: string, input: unknown) => string | undefined;

/** Configurable knobs (defaults match #72's chosen values). */
export interface RouterConfig {
  /** Soft cap per sub-agent transcript before we stop appending NEW items.
      Status mutations (mark a tool 'done') still flow through so a long
      sub-agent always renders clean checkmarks. */
  cap?: number;
  /** Buffer of frames we'll replay once the parent registers. Bounded so
      a runaway emitter can't OOM the engine. Defaults to 200; well above
      any realistic burst before a tool_use block stops. */
  pendingCap?: number;
  /** Monotonic clock — tests stub this so `ts`/`durMs` are deterministic. */
  now?: () => number;
}

/** Stateful router. One instance per `runClaude` invocation. The engine
    creates it once and calls `route(m)` for every event with a non-null
    `parent_tool_use_id`; once the parent's tool_use chip is registered in
    the top-level `toolById`, the engine calls `attachParent(parentId)` to
    replay any buffered events. */
export class SubAgentRouter {
  private writers = new Map<string, SubWriter>();
  /** Frames received BEFORE the parent's tool_use chip was registered. */
  private pending = new Map<string, SubAgentMessage[]>();
  private readonly cap: number;
  private readonly pendingCap: number;
  private readonly now: () => number;

  constructor(
    private readonly toolById: Map<string, TranscriptItem>,
    private readonly toolLabel: ToolLabelFn,
    private readonly toolPreview: ToolPreviewFn,
    private readonly cwd: string,
    cfg: RouterConfig = {},
  ) {
    this.cap = cfg.cap ?? 80;
    this.pendingCap = cfg.pendingCap ?? 200;
    this.now = cfg.now ?? (() => Date.now());
  }

  /** Number of buffered frames awaiting a parent to register. Tests assert
      this drops to zero after `attachParent`. */
  pendingCount(parentId?: string): number {
    if (parentId) return this.pending.get(parentId)?.length ?? 0;
    let n = 0;
    for (const list of this.pending.values()) n += list.length;
    return n;
  }

  /** Route ONE event. Returns true when the event was applied; false when
      it was buffered (parent not yet registered) or ignored (cap reached
      on a non-mutating event). The engine doesn't actually USE the return
      value — it's there for the test suite + future telemetry. */
  route(m: SubAgentMessage): boolean {
    const parentId = m.parent_tool_use_id;
    if (!parentId) return false;
    const parent = this.toolById.get(parentId);
    if (!parent) {
      // Parent not registered yet — BUFFER. Once the engine sees the
      // parent's full assistant message and calls attachParent, we drain.
      const list = this.pending.get(parentId) ?? [];
      if (list.length < this.pendingCap) list.push(m);
      this.pending.set(parentId, list);
      return false;
    }
    return this.apply(parent, m);
  }

  /** Called by the engine when it registers the parent's tool_use chip
      (via the full `assistant` message OR the `content_block_start` early
      hint when the engine grows one). Replays every buffered frame in
      FIFO order — the children array ends up identical to what it would
      have been if there'd been no race. */
  attachParent(parentId: string): void {
    const parent = this.toolById.get(parentId);
    if (!parent) return;
    const buffered = this.pending.get(parentId);
    if (!buffered || !buffered.length) return;
    this.pending.delete(parentId);
    for (const m of buffered) this.apply(parent, m);
  }

  /** Cross-test escape hatch — exposes the underlying writer state for
      grand-child registration. The engine's existing logic needs to
      ALSO register a sub-tool's chip in the top-level toolById so a
      sub-agent-OF-a-sub-agent can find it; we mirror that here. */
  writerFor(parentId: string): SubWriter | undefined {
    return this.writers.get(parentId);
  }

  private apply(parent: TranscriptItem, m: SubAgentMessage): boolean {
    // Lazy-init children[] + writer on the FIRST applied event. We don't
    // initialise on route() because a buffered event might never replay
    // (the parent never registers) and an empty `children: []` would make
    // the renderer show an empty expandable region.
    if (!parent.children) parent.children = [];
    const parentId = String(m.parent_tool_use_id);
    let w = this.writers.get(parentId);
    if (!w) { w = { open: null, openThinking: null, toolById: new Map() }; this.writers.set(parentId, w); }
    const out = parent.children;
    const canAppend = out.length < this.cap;

    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'thinking_delta') {
      if (!w.openThinking) {
        if (!canAppend) return false;
        w.openThinking = { kind: 'thinking', text: '', ts: this.now() };
        out.push(w.openThinking);
      }
      w.openThinking.text += m.event.delta.thinking ?? '';
      return true;
    }
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
      if (!w.open) {
        if (!canAppend) return false;
        w.open = { kind: 'text', text: '', ts: this.now() };
        out.push(w.open);
      }
      w.open.text += m.event.delta.text ?? '';
      return true;
    }
    if (m.type === 'assistant' && m.message?.content) {
      for (const b of m.message.content) {
        if (b.type === 'thinking' && typeof b.thinking === 'string') {
          if (w.openThinking) { w.openThinking.text = b.thinking; w.openThinking = null; }
          else if (b.thinking.trim() && canAppend) out.push({ kind: 'thinking', text: b.thinking, ts: this.now() });
        } else if (b.type === 'text' && typeof b.text === 'string') {
          w.openThinking = null;
          if (w.open) { w.open.text = b.text; w.open = null; }
          else if (b.text.trim() && canAppend) out.push({ kind: 'text', text: b.text, ts: this.now() });
        } else if (b.type === 'tool_use') {
          w.open = null; w.openThinking = null;
          if (!canAppend) continue;
          const label = this.toolLabel(b.name ?? '', b.input, this.cwd);
          const t: TranscriptItem = { kind: 'tool', name: b.name ?? 'tool', text: label.text, toolStatus: 'running', ts: this.now() };
          if (label.cmd) t.cmd = label.cmd;
          const preview = this.toolPreview(b.name ?? '', b.input);
          if (preview !== undefined) t.preview = preview;
          if (b.id) {
            t.id = b.id;
            w.toolById.set(b.id, t);
            // ALSO register in the top-level so a grand-child (sub-agent
            // dispatched BY a sub-agent) can find this chip.
            this.toolById.set(b.id, t);
          }
          out.push(t);
        }
      }
      return true;
    }
    if (m.type === 'user' && m.message?.content) {
      for (const b of m.message.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const t = w.toolById.get(b.tool_use_id);
          if (t) { t.toolStatus = b.is_error ? 'error' : 'done'; t.durMs = this.now() - t.ts; }
        }
      }
      return true;
    }
    return false;
  }
}

/** Pull a sub-agent's final text response out of a tool_result.content
    payload (either a string OR an array of {type:'text',text:…} blocks).
    Pure helper, lives here so the engine + tests both call the same one. */
export function extractToolResultText(c: unknown): string {
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
        const t = (b as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}
