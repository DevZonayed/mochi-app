// Contract-accuracy regression tests for the External MCP manifest.
//
// The whole point of the manifest is that an OUTSIDE agent (Hermes, Cursor,
// Claude Desktop) can only call a Mochi tool correctly if the advertised
// `inputSchema` property names match the ones the matching dispatch case in
// ../localApi.ts actually reads off `params`. History shows this drifts: the
// manifest documented `openProject {projectId}` while dispatch reads `p.id`,
// and `sendChat {prompt}` while dispatch reads `p.text` — so a valid-looking
// tool call silently did nothing. These tests pin the contract and — via a
// source-parsing drift guard — fail the build if a future edit to localApi.ts
// renames a required param out from under its schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MCP_TOOLS, MCP_TOOL_BY_METHOD, TOOL_SCHEMAS, SCHEMA_DRIFT_EXEMPT, toMcpTool,
} from './manifest.ts';

const localApiSrc = readFileSync(fileURLToPath(new URL('../localApi.ts', import.meta.url)), 'utf8');

/** Slice out each `case '<method>':` body from the dispatch switch (from its
    label up to the next case/default label). Good enough to assert which
    `p.<name>` reads live inside a given method's arm. */
function caseBlocks(src: string): Map<string, string> {
  const labelRe = /\bcase\s+'([^']+)'\s*:|^\s*default\s*:/gm;
  const marks: Array<{ method: string | null; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(src)) !== null) marks.push({ method: m[1] ?? null, index: m.index });
  const blocks = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const { method, index } = marks[i];
    if (!method) continue;
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
    // Later duplicate labels can't happen in a switch; first wins.
    if (!blocks.has(method)) blocks.set(method, src.slice(index, end));
  }
  return blocks;
}
const BLOCKS = caseBlocks(localApiSrc);
const reads = (block: string, prop: string) => new RegExp(`\\bp\\.${prop}\\b`).test(block);

describe('manifest schema coverage', () => {
  it('every tool has an explicit input schema (never the bare passthrough)', () => {
    for (const t of MCP_TOOLS) {
      expect(TOOL_SCHEMAS[t.method], `${t.method} missing from TOOL_SCHEMAS`).toBeDefined();
      expect(t.inputSchema, `${t.method} inputSchema`).toBe(TOOL_SCHEMAS[t.method]);
    }
  });
  it('every input schema is a well-formed object schema', () => {
    for (const t of MCP_TOOLS) {
      const s = t.inputSchema;
      expect(s.type, t.method).toBe('object');
      expect(s.additionalProperties, t.method).toBe(true);
      expect(typeof s.properties, t.method).toBe('object');
      for (const req of s.required ?? []) {
        expect(s.properties[req], `${t.method}.required[${req}] must be a declared property`).toBeDefined();
      }
    }
  });
  it('toMcpTool exposes the accurate schema to tools/list', () => {
    const open = toMcpTool(MCP_TOOL_BY_METHOD.get('openProject')!);
    expect(open.inputSchema.properties).toHaveProperty('projectId');
    expect(open.inputSchema.properties).toHaveProperty('id');
  });
});

describe('reported contract bugs are fixed', () => {
  it('openProject accepts canonical projectId OR the legacy id alias', () => {
    const s = TOOL_SCHEMAS.openProject;
    expect(s.properties).toHaveProperty('projectId');
    expect(s.properties).toHaveProperty('id');
    // No single required key — the oneOf(projectId,id) alternation enforces one.
    expect(s.required ?? []).toEqual([]);
    expect(Array.isArray(s.anyOf)).toBe(true);
    // dispatch resolves the project id via the shared projectIdOf(p) helper.
    expect(BLOCKS.get('openProject')!).toMatch(/projectIdOf\(p\)/);
  });
  it('sendChat: text is canonical, prompt/message are INTENTIONAL aliases dispatch reads', () => {
    const s = TOOL_SCHEMAS.sendChat;
    expect(s.properties).toHaveProperty('text');
    // prompt/message are now documented aliases (dispatch reads text ?? prompt ?? message).
    expect(s.properties).toHaveProperty('prompt');
    expect(s.properties).toHaveProperty('message');
    expect(s.required).toContain('projectId');
    const block = BLOCKS.get('sendChat')!;
    expect(reads(block, 'text')).toBe(true);
    expect(reads(block, 'prompt')).toBe(true);
    expect(reads(block, 'message')).toBe(true);
    expect(reads(block, 'projectId')).toBe(true);
  });
  it('steerJob reads {id, text}, NOT {jobId}', () => {
    const s = TOOL_SCHEMAS.steerJob;
    expect(s.properties).toHaveProperty('id');
    expect(s.properties).toHaveProperty('text');
    expect(s.properties).not.toHaveProperty('jobId');
    expect(s.required).toEqual(['id', 'text']);
  });
  it('question tools expose exact sourceJobId identity while keeping session compatibility', () => {
    expect(TOOL_SCHEMAS.answerQuestion.properties).toHaveProperty('sessionId');
    expect(TOOL_SCHEMAS.answerQuestion.properties).toHaveProperty('sourceJobId');
    expect(TOOL_SCHEMAS.answerQuestion.required).toEqual(['answer']);
    expect(reads(BLOCKS.get('answerQuestion')!, 'sourceJobId')).toBe(true);

    expect(TOOL_SCHEMAS.extendQuestion.properties).toHaveProperty('sessionId');
    expect(TOOL_SCHEMAS.extendQuestion.properties).toHaveProperty('sourceJobId');
    expect(TOOL_SCHEMAS.extendQuestion.required ?? []).toEqual([]);
    expect(reads(BLOCKS.get('extendQuestion')!, 'sourceJobId')).toBe(true);

    expect(TOOL_SCHEMAS.cancelQuestion.properties).toHaveProperty('sessionId');
    expect(TOOL_SCHEMAS.cancelQuestion.properties).toHaveProperty('sourceJobId');
    expect(TOOL_SCHEMAS.cancelQuestion.required ?? []).toEqual([]);
    expect(reads(BLOCKS.get('cancelQuestion')!, 'sourceJobId')).toBe(true);
  });
  it('project-scoped tools accept canonical projectId + the legacy id alias', () => {
    // These arms resolve their PROJECT id via projectIdOf(p) = projectId ?? id.
    for (const m of ['getProject', 'getProjectMemory', 'setProjectMemory', 'snapshotProject',
      'openProject', 'closeProject', 'updateProject', 'getProjectRepo', 'revealProject', 'deleteProject']) {
      expect(TOOL_SCHEMAS[m].properties, `${m} projectId`).toHaveProperty('projectId');
      expect(TOOL_SCHEMAS[m].properties, `${m} id alias`).toHaveProperty('id');
    }
    // The design-comment + skill arms still take the project id as `id` (unchanged
    // in this fix; their id semantics are entangled with comment/skill ids).
    for (const m of ['listDesignComments', 'listProjectSkills']) {
      expect(TOOL_SCHEMAS[m].properties, `${m} id`).toHaveProperty('id');
      expect(TOOL_SCHEMAS[m].properties, `${m} no projectId`).not.toHaveProperty('projectId');
    }
  });
  it('the id-vs-{jobId,assetId,runId} renames are corrected', () => {
    expect(TOOL_SCHEMAS.getJob.required).toEqual(['id']);
    expect(TOOL_SCHEMAS.getAsset.required).toEqual(['id']);
    expect(TOOL_SCHEMAS.deleteAsset.required).toEqual(['id']);
    expect(TOOL_SCHEMAS.killCommand.properties).toHaveProperty('runId');
    expect(TOOL_SCHEMAS.killCommand.required).toEqual(['runId']);
    expect(reads(BLOCKS.get('killCommand')!, 'runId')).toBe(true);
  });
  it('whatsapp send/react/recipient params match dispatch', () => {
    expect(TOOL_SCHEMAS.waSendText.required).toEqual(['chatId', 'text']);
    expect(TOOL_SCHEMAS.waReact.required).toEqual(['chatId', 'msgId', 'emoji']);
    expect(TOOL_SCHEMAS.waReact.properties).not.toHaveProperty('messageId');
    expect(TOOL_SCHEMAS.setWhatsappRecipient.properties).toHaveProperty('number');
    expect(TOOL_SCHEMAS.setWhatsappAgentSend.properties).toHaveProperty('on');
  });
});

describe('drift guard — every schema.required is actually read by its dispatch case', () => {
  it('all manifest methods exist as a dispatch case', () => {
    const missing = MCP_TOOLS.map((t) => t.method).filter((m) => !BLOCKS.has(m));
    expect(missing, `manifest tools with no dispatch case: ${missing.join(', ')}`).toEqual([]);
  });

  it('reads ⊆ declared: every direct p.<prop> read in a case is a declared property', () => {
    // The complete contract invariant: a generic MCP client is told the tool
    // accepts `inputSchema.properties`, so anything the dispatch case DIRECTLY
    // reads off params (p.<name>) must be advertised. (The reverse — declared but
    // not directly read — is fine: updateProject/updateSchedule apply a dynamic
    // allowlist/spread over p[k], so those fields never appear as a literal
    // p.<name>. additionalProperties stays true; this is about honest docs.)
    const propRe = /\bp\.([A-Za-z_$][\w$]*)\b/g;
    const violations: string[] = [];
    for (const t of MCP_TOOLS) {
      if (SCHEMA_DRIFT_EXEMPT.has(t.method)) continue; // params consumed in a shared helper
      const block = BLOCKS.get(t.method);
      if (!block) continue;
      const declared = new Set(Object.keys(t.inputSchema.properties));
      const seen = new Set<string>();
      let mm: RegExpExecArray | null;
      while ((mm = propRe.exec(block)) !== null) seen.add(mm[1]);
      for (const prop of seen) {
        if (!declared.has(prop)) violations.push(`${t.method}: reads p.${prop} but it is not declared in inputSchema.properties`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('required props are literally read as p.<name> in the matching case', () => {
    const violations: string[] = [];
    for (const t of MCP_TOOLS) {
      if (SCHEMA_DRIFT_EXEMPT.has(t.method)) continue; // params parsed in a shared helper
      const block = BLOCKS.get(t.method);
      if (!block) continue; // covered by the test above
      for (const req of t.inputSchema.required ?? []) {
        if (!reads(block, req)) violations.push(`${t.method}: required '${req}' is not read as p.${req}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('drift-exempt methods are exempt for a real reason (delegate to a helper)', () => {
    for (const m of SCHEMA_DRIFT_EXEMPT) {
      const block = BLOCKS.get(m);
      expect(block, `${m} should still be a dispatch case`).toBeTruthy();
      expect(/normalizeMcpInput\(p\)/.test(block!), `${m} should delegate to normalizeMcpInput`).toBe(true);
    }
  });
});
