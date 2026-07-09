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
    expect(open.inputSchema.properties).toHaveProperty('id');
    expect(open.inputSchema.required).toContain('id');
  });
});

describe('reported contract bugs are fixed', () => {
  it('openProject reads {id}, NOT {projectId}', () => {
    const s = TOOL_SCHEMAS.openProject;
    expect(s.properties).toHaveProperty('id');
    expect(s.properties).not.toHaveProperty('projectId');
    expect(s.required).toEqual(['id']);
    expect(reads(BLOCKS.get('openProject')!, 'id')).toBe(true);
  });
  it('sendChat reads {text}, NOT {prompt}, and requires projectId', () => {
    const s = TOOL_SCHEMAS.sendChat;
    expect(s.properties).toHaveProperty('text');
    expect(s.properties).not.toHaveProperty('prompt');
    expect(s.required).toContain('projectId');
    const block = BLOCKS.get('sendChat')!;
    expect(reads(block, 'text')).toBe(true);
    expect(reads(block, 'projectId')).toBe(true);
  });
  it('steerJob reads {id, text}, NOT {jobId}', () => {
    const s = TOOL_SCHEMAS.steerJob;
    expect(s.properties).toHaveProperty('id');
    expect(s.properties).toHaveProperty('text');
    expect(s.properties).not.toHaveProperty('jobId');
    expect(s.required).toEqual(['id', 'text']);
  });
  it('the id-vs-projectId family all read {id}', () => {
    for (const m of ['getProject', 'getProjectMemory', 'updateProject', 'deleteProject', 'getProjectRepo', 'listDesignComments', 'listProjectSkills']) {
      expect(TOOL_SCHEMAS[m].properties, `${m} should document id`).toHaveProperty('id');
      expect(TOOL_SCHEMAS[m].properties, `${m} should NOT document projectId`).not.toHaveProperty('projectId');
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
