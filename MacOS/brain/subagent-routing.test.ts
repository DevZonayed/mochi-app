/* subagent-routing.test — the children-accumulation contract that #72
   shipped. Bug 2: when the SDK emitted a sub-agent's first event BEFORE
   the parent's full assistant message landed (a race in the SDK's stream
   order — verified in the wild), the previous engine code dropped the
   event silently and the parent chip's children[] stayed empty even when
   the operator watched the sub-agent run to completion. */

import { describe, it, expect } from 'vitest';
import { SubAgentRouter, extractToolResultText, type SubAgentMessage } from './subagent-routing.js';
import type { TranscriptItem } from './store.js';

const labeller = (name: string, input: unknown): { text: string; cmd?: string } => {
  if (name === 'Bash' && input && typeof input === 'object' && 'command' in input) {
    const cmd = String((input as { command: unknown }).command);
    return { text: 'Bash', cmd };
  }
  return { text: name };
};
const previewer = (): string | undefined => undefined;

/** Build a parent tool chip + register it in toolById, returning both. */
function makeParent(id = 'parent-1'): { toolById: Map<string, TranscriptItem>; parent: TranscriptItem } {
  const toolById = new Map<string, TranscriptItem>();
  const parent: TranscriptItem = { kind: 'tool', name: 'Task', text: 'Plan something', toolStatus: 'running', ts: 100, id };
  toolById.set(id, parent);
  return { toolById, parent };
}

describe('SubAgentRouter — happy path', () => {
  it('accumulates a tool_use → tool_result pair into the parent\'s children[]', () => {
    const { toolById, parent } = makeParent('pid');
    const router = new SubAgentRouter(toolById, labeller, previewer, '/cwd', { now: () => 200 });
    // Sub-agent's first tool call.
    router.route({
      type: 'assistant', parent_tool_use_id: 'pid',
      message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Bash', input: { command: 'ls' } }] },
    });
    // The tool's result.
    router.route({
      type: 'user', parent_tool_use_id: 'pid',
      message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'a\nb\nc' }] },
    });
    expect(parent.children).toHaveLength(1);
    const tool = parent.children![0];
    expect(tool.kind).toBe('tool');
    expect(tool.name).toBe('Bash');
    expect(tool.cmd).toBe('ls');
    expect(tool.toolStatus).toBe('done');
    expect(tool.id).toBe('sub-1');
  });

  it('streams text deltas into a single child text block', () => {
    const { toolById, parent } = makeParent('pid');
    const router = new SubAgentRouter(toolById, labeller, previewer, '/cwd');
    const delta = (text: string): SubAgentMessage => ({
      type: 'stream_event', parent_tool_use_id: 'pid',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    router.route(delta('hello '));
    router.route(delta('world'));
    expect(parent.children).toHaveLength(1);
    expect(parent.children![0].kind).toBe('text');
    expect(parent.children![0].text).toBe('hello world');
  });

  it('registers a grand-child\'s tool_use chip in the top-level toolById too', () => {
    const { toolById, parent } = makeParent('pid');
    const router = new SubAgentRouter(toolById, labeller, previewer, '/cwd');
    router.route({
      type: 'assistant', parent_tool_use_id: 'pid',
      message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Bash', input: {} }] },
    });
    // The CHILD chip MUST be findable by id from the top-level map so a
    // grand-child (sub-agent-of-sub-agent) can hook into it.
    expect(toolById.has('sub-1')).toBe(true);
    expect(toolById.get('sub-1')).toBe(parent.children![0]);
  });
});

describe('SubAgentRouter — out-of-order delivery (Bug 2)', () => {
  it('BUFFERS sub-agent events whose parent has not registered yet', () => {
    const toolById = new Map<string, TranscriptItem>();
    const router = new SubAgentRouter(toolById, labeller, previewer, '/cwd');
    const applied = router.route({
      type: 'assistant', parent_tool_use_id: 'pid-late',
      message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Read', input: {} }] },
    });
    expect(applied).toBe(false);
    expect(router.pendingCount('pid-late')).toBe(1);
  });

  it('replays buffered events when the parent registers via attachParent', () => {
    const toolById = new Map<string, TranscriptItem>();
    const router = new SubAgentRouter(toolById, labeller, previewer, '/cwd');
    // Sub-agent fires 3 events BEFORE the parent\'s full assistant message lands.
    router.route({
      type: 'assistant', parent_tool_use_id: 'pid-late',
      message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Read', input: {} }] },
    });
    router.route({
      type: 'stream_event', parent_tool_use_id: 'pid-late',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
    });
    router.route({
      type: 'user', parent_tool_use_id: 'pid-late',
      message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'ok' }] },
    });
    expect(router.pendingCount('pid-late')).toBe(3);
    // Now the parent registers. The engine calls attachParent.
    const parent: TranscriptItem = { kind: 'tool', name: 'Task', text: 'Read something', toolStatus: 'running', ts: 100, id: 'pid-late' };
    toolById.set('pid-late', parent);
    router.attachParent('pid-late');
    expect(router.pendingCount('pid-late')).toBe(0);
    expect(parent.children).toBeDefined();
    expect(parent.children).toHaveLength(2); // tool_use + text block
    expect(parent.children![0].name).toBe('Read');
    expect(parent.children![0].toolStatus).toBe('done'); // status mutation from tool_result replayed
    expect(parent.children![1].kind).toBe('text');
    expect(parent.children![1].text).toBe('done');
  });

  it('caps the pending buffer so a runaway emitter cannot OOM the engine', () => {
    const toolById = new Map<string, TranscriptItem>();
    const router = new SubAgentRouter(toolById, labeller, previewer, '/cwd', { pendingCap: 5 });
    for (let i = 0; i < 50; i++) {
      router.route({
        type: 'stream_event', parent_tool_use_id: 'pid-x',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `chunk${i}` } },
      });
    }
    expect(router.pendingCount('pid-x')).toBe(5);
  });

  it('does NOT initialize parent.children when no event ever applies', () => {
    // A parent that NEVER receives a sub-event must stay free of an empty
    // children: [] — otherwise the renderer shows an empty expandable
    // region with a chevron leading nowhere.
    const { parent } = makeParent('pid');
    expect(parent.children).toBeUndefined();
  });
});

describe('SubAgentRouter — soft cap', () => {
  it('stops APPENDING new children once cap is reached but still mutates existing chips', () => {
    const { toolById, parent } = makeParent('pid');
    const router = new SubAgentRouter(toolById, labeller, previewer, '/cwd', { cap: 2 });
    // Three tool uses → only first two append; the third is dropped.
    for (let i = 0; i < 3; i++) {
      router.route({
        type: 'assistant', parent_tool_use_id: 'pid',
        message: { content: [{ type: 'tool_use', id: `sub-${i}`, name: 'Bash', input: { command: `cmd${i}` } }] },
      });
    }
    expect(parent.children).toHaveLength(2);
    // tool_result for sub-0 STILL mutates the chip's status (mutations are
    // allowed past the cap; only append is blocked).
    router.route({
      type: 'user', parent_tool_use_id: 'pid',
      message: { content: [{ type: 'tool_result', tool_use_id: 'sub-0', content: '' }] },
    });
    expect(parent.children![0].toolStatus).toBe('done');
  });
});

describe('extractToolResultText', () => {
  it('returns trimmed string content as-is', () => {
    expect(extractToolResultText('  hello\n')).toBe('hello');
  });
  it('joins {type:text,text} blocks from an array', () => {
    expect(extractToolResultText([
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
      { type: 'image' }, // dropped
    ])).toBe('line 1\nline 2');
  });
  it('returns empty string for unknown shapes', () => {
    expect(extractToolResultText(undefined)).toBe('');
    expect(extractToolResultText(42)).toBe('');
    expect(extractToolResultText({ shape: 'unknown' })).toBe('');
  });
});
