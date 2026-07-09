// Behavior-focused contract tests for the External MCP tool schemas.
//
// These validate the ADVERTISED inputSchema against real JSON Schema semantics
// (via ajv) — not just "is this property declared". They pin the honest
// alternatives/unions that match what each localApi dispatch case actually
// accepts/rejects: required projectId for the file tools, "at least one of"
// groups, transport-dependent MCP fields, alias-OR-canonical requirements, and
// union-typed properties (reviewer 'off'|object, scheduledAt number|null).

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { TOOL_SCHEMAS } from './manifest.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function ok(method: string, input: unknown): boolean {
  let v = validators.get(method);
  if (!v) { v = ajv.compile(TOOL_SCHEMAS[method]); validators.set(method, v); }
  return v(input) as boolean;
}
const accepts = (method: string, ...inputs: unknown[]) => {
  for (const i of inputs) expect(ok(method, i), `${method} should ACCEPT ${JSON.stringify(i)}`).toBe(true);
};
const rejects = (method: string, ...inputs: unknown[]) => {
  for (const i of inputs) expect(ok(method, i), `${method} should REJECT ${JSON.stringify(i)}`).toBe(false);
};

describe('file tools require projectId (dispatch cannot derive it from sessionId)', () => {
  it('readFile', () => {
    accepts('readFile', { projectId: 'p', path: 'a.ts' }, { projectId: 'p', path: 'a.ts', sessionId: 's' });
    rejects('readFile', { path: 'a.ts' }, { sessionId: 's', path: 'a.ts' }, { projectId: 'p' });
  });
  it('listDir', () => {
    accepts('listDir', { projectId: 'p', path: 'dir' });
    rejects('listDir', { path: 'dir' }, { projectId: 'p' });
  });
  it('writeFile', () => {
    accepts('writeFile', { projectId: 'p', path: 'a.ts', text: 'x' });
    rejects('writeFile', { path: 'a.ts', text: 'x' }, { projectId: 'p', path: 'a.ts' }, { projectId: 'p', text: 'x' });
  });
});

describe('sendChat: projectId + at least one non-empty of text/images/files', () => {
  it('accepts a message, an image, or a file', () => {
    accepts('sendChat',
      { projectId: 'p', text: 'hi' },
      { projectId: 'p', images: [{ dataB64: 'x' }] },
      { projectId: 'p', files: [{ name: 'f' }] },
    );
  });
  it('rejects missing projectId or an empty/absent payload', () => {
    rejects('sendChat',
      { projectId: 'p' },
      { projectId: 'p', text: '' },
      { projectId: 'p', text: '   ' }, // whitespace-only: dispatch trims → empty → rejected
      { projectId: 'p', images: [] },
      { text: 'hi' },
    );
  });
});

describe('waSendMedia: chatId + (path or dataB64)', () => {
  it('accepts either media source', () => {
    accepts('waSendMedia', { chatId: 'c', path: '/x' }, { chatId: 'c', dataB64: 'aa' });
  });
  it('rejects no source or no chatId', () => {
    rejects('waSendMedia', { chatId: 'c' }, { path: '/x' });
  });
  it('rejects an empty/whitespace path or dataB64 (must be a meaningful nonblank string)', () => {
    rejects('waSendMedia',
      { chatId: 'c', path: '' },
      { chatId: 'c', path: '   ' },
      { chatId: 'c', dataB64: '' },
      { chatId: 'c', dataB64: '  ' },
    );
  });
});

describe('updateFeedback: id + status (the only accepted patch field)', () => {
  it('requires a valid status', () => {
    accepts('updateFeedback', { id: 'f', status: 'done' });
    rejects('updateFeedback', { id: 'f' }, { id: 'f', status: 'bogus' }, { status: 'done' });
  });
});

describe('union-typed properties', () => {
  it('setRoles.reviewer allows the literal "off" OR an object', () => {
    accepts('setRoles', { reviewer: 'off' }, { reviewer: { engine: 'claude' } }, {});
    rejects('setRoles', { reviewer: 123 }, { reviewer: 'on' });
  });
  it('updateDraft.scheduledAt allows number OR null', () => {
    accepts('updateDraft', { id: 'd', scheduledAt: null }, { id: 'd', scheduledAt: 123 });
    rejects('updateDraft', { id: 'd', scheduledAt: 'soon' });
  });
});

describe('addMcpServer / updateMcpServer: transport-dependent command|url', () => {
  it('addMcpServer: name + (command for stdio | url for http)', () => {
    accepts('addMcpServer',
      { name: 'x', command: 'npx' },
      { name: 'x', transport: 'http', url: 'https://a/mcp' },
    );
    rejects('addMcpServer',
      { name: 'x' },
      { name: 'x', transport: 'http' },
      { command: 'npx' },
      // http must require a url even if a stray command is present:
      { name: 'x', transport: 'http', command: 'npx' },
      // empty/blank url or command are not meaningful:
      { name: 'x', transport: 'http', url: '' },
      { name: 'x', transport: 'http', url: '   ' },
      { name: 'x', command: '' },
      { name: 'x', transport: 'stdio', command: '  ' },
    );
  });
  it('updateMcpServer: also requires id (and name), and enforces transport-dependent url', () => {
    accepts('updateMcpServer', { id: 's', name: 'x', command: 'npx' }, { id: 's', name: 'x', transport: 'http', url: 'https://a' });
    rejects('updateMcpServer',
      { name: 'x', command: 'npx' },
      { id: 's', command: 'npx' },
      { id: 's', name: 'x', transport: 'http', command: 'npx' }, // http + command but no url
      { id: 's', name: 'x', transport: 'http', url: '' },        // empty url
    );
  });
});

describe('alias-OR-canonical requirements (dispatch reads canonical ?? alias)', () => {
  it('archiveSessionWorktree: sessionId | id', () => {
    accepts('archiveSessionWorktree', { sessionId: 's' }, { id: 's' });
    rejects('archiveSessionWorktree', {}, { deleteBranch: true });
  });
  it('getJobDiff: id | jobId', () => {
    accepts('getJobDiff', { id: 'j' }, { jobId: 'j' });
    rejects('getJobDiff', {});
  });
  it('registryGetSkill / registrySkillContent: id | skillId', () => {
    accepts('registryGetSkill', { id: 's' }, { skillId: 's' });
    rejects('registryGetSkill', {});
    accepts('registrySkillContent', { id: 's' }, { skillId: 's' });
    rejects('registrySkillContent', {});
  });
  it('regenerateImage: assetId | id', () => {
    accepts('regenerateImage', { assetId: 'a' }, { id: 'a' });
    rejects('regenerateImage', {});
  });
  it('addSkillToProject: (projectId | id) + skillId', () => {
    accepts('addSkillToProject', { projectId: 'p', skillId: 's' }, { id: 'p', skillId: 's' });
    rejects('addSkillToProject', { skillId: 's' }, { projectId: 'p' });
  });
  it('setProjectSkillEnabled: (projectId | id) + (skillId | slug) + enabled', () => {
    accepts('setProjectSkillEnabled',
      { projectId: 'p', skillId: 's', enabled: true },
      { id: 'p', slug: 's', enabled: false },
    );
    rejects('setProjectSkillEnabled',
      { projectId: 'p', enabled: true },
      { skillId: 's', enabled: true },
      { projectId: 'p', skillId: 's' },
    );
  });
  it('removeSkillFromProject: (projectId | id) + (skillId | slug)', () => {
    accepts('removeSkillFromProject', { projectId: 'p', skillId: 's' }, { id: 'p', slug: 's' });
    rejects('removeSkillFromProject', { projectId: 'p' }, { skillId: 's' });
  });
});

describe('session-targeted tools accept both sessionId and id (schema/dispatch parity)', () => {
  it('setSessionAutopilot: (sessionId | id) + (enabled | on)', () => {
    accepts('setSessionAutopilot',
      { sessionId: 's', on: true }, { id: 's', enabled: true }, { sessionId: 's', enabled: false });
    rejects('setSessionAutopilot',
      { on: true },                 // no session id
      { sessionId: 's' },           // no enable flag
      {});
  });
  it('setSessionReviewer: (sessionId | id) + (reviewer | enabled | on); reviewer is object|"off"', () => {
    accepts('setSessionReviewer',
      { sessionId: 's', reviewer: { engine: 'codex', model: 'gpt-5.5' } },
      { sessionId: 's', reviewer: 'off' },
      { id: 's', enabled: true },
      { sessionId: 's', on: false });
    rejects('setSessionReviewer',
      { reviewer: { engine: 'codex' } }, // no session id
      { sessionId: 's' },                // nothing to set
      { sessionId: 's', reviewer: 'on' },// only "off" is a valid string
      { sessionId: 's', reviewer: {} },  // a role object must carry an engine
      { sessionId: 's', reviewer: 123 });
  });
  it('non-destructive git session tools: sessionId | id', () => {
    for (const m of ['refreshSessionGitStatus', 'getSessionGitStatus', 'previewSessionMerge', 'previewSessionResolve',
      'getConflictHunks', 'setConflictResolveHint', 'renameSessionBranch']) {
      accepts(m, { sessionId: 's' }, { id: 's' });
      rejects(m, {});
    }
  });
  it('destructive PR tools accept sessionId ONLY — no id alias on irreversible actions', () => {
    for (const m of ['pushSession', 'createSessionPR', 'mergeSessionPR', 'resolveSession']) {
      accepts(m, { sessionId: 's' });
      rejects(m, {}, { id: 's' });
    }
  });
  it('id-canonical session tools also take sessionId', () => {
    accepts('renameSession', { id: 's', title: 't' }, { sessionId: 's', title: 't' });
    rejects('renameSession', { title: 't' }, { id: 's' });
    accepts('deleteSession', { id: 's' }, { sessionId: 's' });
    rejects('deleteSession', {});
    accepts('pinSession', { id: 's', pinned: true }, { sessionId: 's', pinned: false });
    rejects('pinSession', { pinned: true }, { id: 's' });
    accepts('archiveSession', { id: 's', archived: true }, { sessionId: 's', archived: false });
    rejects('archiveSession', { archived: true }, { id: 's' });
    accepts('continueSession', { sessionId: 's' }, { id: 's' });
    rejects('continueSession', {});
    accepts('answerQuestion', { sessionId: 's', answer: 'a' }, { id: 's', answer: 'a' });
    rejects('answerQuestion', { answer: 'a' }, { sessionId: 's' });
    accepts('extendQuestion', { sessionId: 's' }, { id: 's' });
    rejects('extendQuestion', {});
  });
});

describe('sendChat: text canonical + prompt/message aliases satisfy the payload rule', () => {
  it('accepts prompt or message in place of text', () => {
    accepts('sendChat',
      { projectId: 'p', prompt: 'hi' },
      { projectId: 'p', message: 'hi' });
  });
  it('a blank prompt/message does NOT satisfy the payload requirement', () => {
    rejects('sendChat',
      { projectId: 'p', prompt: '   ' },
      { projectId: 'p', message: '' });
  });
});
