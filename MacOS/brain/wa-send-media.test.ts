/**
 * WhatsApp agent media sending — RED-first contract + regression tests.
 *
 * 1. WhatsAppClient.sendMedia group JID regression
 * 2. Production tool-surface contract: tool names, allowed list, directive, handler
 * 3. Production handler test: stages a file, invokes the real handleWaSendMedia,
 *    verifies target cascade + waSendAllowed + exact bytes/kind/mime/fileName/caption
 * 4. Text sending unchanged (regression)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-wa-media-test-${process.pid}` }));
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir },
  powerMonitor: { on: () => {} },
}));

import { Store } from './store.js';
import { WhatsAppClient, waSendAllowed } from './whatsapp.js';
import { WA_TOOL_NAMES, resolveWaTarget, handleWaSendMedia, buildWaTools } from './wa-agent-tools.js';
import { WHATSAPP_DIRECTIVE, buildCommsCtx } from './engine.js';
import type { CommsCtx, WaAgentClient } from './engine.js';

/** Minimal baileys socket mock — records sends with full content. */
function mockSocket(ownId = '15551234567:3@s.whatsapp.net') {
  const handlers: Record<string, Array<(p: unknown) => void>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent: Array<{ jid: string; content: any }> = [];
  const sock = {
    ev: { on: (e: string, cb: (p: unknown) => void) => { (handlers[e] ||= []).push(cb); } },
    user: { id: ownId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMessage: async (jid: string, c: any) => {
      sent.push({ jid, content: c });
      return { key: { id: `srv-media-${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    readMessages: async () => {},
    end: () => {},
  };
  const fire = (e: string, p: unknown) => { (handlers[e] || []).forEach(cb => cb(p)); };
  return { sock, sent, fire };
}

/** Build a mock WaAgentClient that records sendMedia calls. */
function mockWaClient(): WaAgentClient & { mediaCalls: Array<{ chatId: string; media: unknown }> } {
  const mediaCalls: Array<{ chatId: string; media: unknown }> = [];
  return {
    sendText: async () => true,
    markRead: async () => {},
    sendMedia: async (chatId, media) => { mediaCalls.push({ chatId, media }); return true; },
    mediaCalls,
  };
}

/** Build a CommsCtx with a mock client for handler testing. */
function mockCommsCtx(opts: {
  ownJid?: string;
  notifyJid?: string | null;
  canSendOthers?: boolean;
  client?: WaAgentClient & { mediaCalls: Array<{ chatId: string; media: unknown }> };
  recordContextSend?: CommsCtx['recordContextSend'];
} = {}): { ctx: CommsCtx; client: ReturnType<typeof mockWaClient> } {
  const client = opts.client ?? mockWaClient();
  const ctx: CommsCtx = {
    ownJid: () => opts.ownJid ?? '15551234567@s.whatsapp.net',
    notifyJid: () => opts.notifyJid ?? null,
    canSendOthers: () => opts.canSendOthers ?? false,
    projectChatIds: () => [],
    listChats: () => [],
    getMessages: () => [],
    sendText: (chatId, text) => client.sendText(chatId, text),
    sendMedia: (chatId, media) => client.sendMedia(chatId, media),
    markRead: (chatId) => client.markRead(chatId),
    recordContextSend: opts.recordContextSend,
  };
  return { ctx, client };
}

beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });
afterEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

// ────── 1. WhatsAppClient.sendMedia group regression ──────

describe('WhatsAppClient.sendMedia — group JID', () => {
  it('sends an image to a @g.us group and stores the outgoing media descriptor', async () => {
    const s = new Store();
    const { sock, sent, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('connection.update', { connection: 'open' });

    const groupJid = '120363423190535250@g.us';
    const imgBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ok = await client.sendMedia(groupJid, {
      kind: 'image', data: imgBuf, mimetype: 'image/png', fileName: 'screenshot.png', caption: 'Build output',
    });

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe(groupJid);
    expect(sent[0].content.image).toEqual(imgBuf);
    expect(sent[0].content.caption).toBe('Build output');

    const msgs = s.waMessages(groupJid);
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const last = msgs[msgs.length - 1];
    expect(last.fromMe).toBe(true);
    expect(last.kind).toBe('image');
    expect(last.media).toMatchObject({ kind: 'image', mimetype: 'image/png', fileName: 'screenshot.png' });
  });

  it('sends a document to a group', async () => {
    const s = new Store();
    const { sock, sent, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('connection.update', { connection: 'open' });

    const ok = await client.sendMedia('120363423190535250@g.us', {
      kind: 'document', data: Buffer.from('PDF content'), mimetype: 'application/pdf', fileName: 'report.pdf', caption: 'Weekly report',
    });

    expect(ok).toBe(true);
    expect(sent[0].content.document).toBeDefined();
    expect(sent[0].content.fileName).toBe('report.pdf');
  });

  it('returns false when socket is not connected', async () => {
    const s = new Store();
    const client = new WhatsAppClient(s, vi.fn());
    const ok = await client.sendMedia('120363423190535250@g.us', {
      kind: 'image', data: Buffer.from([1, 2, 3]),
    });
    expect(ok).toBe(false);
  });
});

// ────── 2. Canonical tool-name list (drift-proof) ──────

describe('WA_TOOL_NAMES — canonical tool list', () => {
  it('includes wa_send_media', () => {
    expect(WA_TOOL_NAMES).toContain('wa_send_media');
  });

  it('includes all five WA tools in exact order', () => {
    expect([...WA_TOOL_NAMES]).toEqual([
      'wa_list_chats', 'wa_get_messages', 'wa_send_message', 'wa_send_media', 'wa_mark_read',
    ]);
  });

  it('buildWaTools registers exactly WA_TOOL_NAMES.length tools', () => {
    const registered: string[] = [];
    const fakeTool = (name: string) => { registered.push(name); return { name }; };
    const fakeWrap = (fn: unknown) => fn;
    const { ctx } = mockCommsCtx();
    const tmpDir = mkdtempSync(join(tmpdir(), 'wa-tools-'));
    try {
      buildWaTools({ tool: fakeTool, wrap: fakeWrap, commsCtx: ctx, cwd: tmpDir });
      // Verify EXACT match — no extra, no missing
      expect(registered).toEqual([...WA_TOOL_NAMES]);
    } finally { rmSync(tmpDir, { recursive: true, force: true }); }
  });

  it('fails if wa_send_media is removed from WA_TOOL_NAMES', () => {
    // This test documents the contract: WA_TOOL_NAMES is the single source of truth.
    // If someone removes wa_send_media from the list, this test fails.
    const idx = WA_TOOL_NAMES.indexOf('wa_send_media');
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});

// ────── 3. WHATSAPP_DIRECTIVE ──────

describe('WHATSAPP_DIRECTIVE', () => {
  it('mentions wa_send_media', () => {
    expect(WHATSAPP_DIRECTIVE).toContain('wa_send_media');
  });

  it('instructs the agent to save files in .continuum/Attachment/', () => {
    expect(WHATSAPP_DIRECTIVE).toContain('.continuum/Attachment/');
  });
});

// ────── 4. buildCommsCtx — production path (no dead duplication) ──────

describe('buildCommsCtx', () => {
  it('returns CommsCtx with sendMedia when connected', () => {
    const s = new Store();
    s.setWhatsappState({ connected: true, jid: '111@s.whatsapp.net' });
    const client = mockWaClient();
    const ctx = buildCommsCtx(s, client, '');
    expect(ctx).toBeDefined();
    expect(typeof ctx!.sendMedia).toBe('function');
    expect(typeof ctx!.sendText).toBe('function');
    expect(typeof ctx!.markRead).toBe('function');
  });

  it('returns undefined when not connected', () => {
    const s = new Store();
    s.setWhatsappState({ connected: false });
    const client = mockWaClient();
    const ctx = buildCommsCtx(s, client, '');
    expect(ctx).toBeUndefined();
  });
});

// ────── 5. resolveWaTarget ──────

describe('resolveWaTarget', () => {
  it('uses chatId when provided', () => {
    const { ctx } = mockCommsCtx();
    expect(resolveWaTarget({ chatId: 'x@g.us' }, ctx)).toBe('x@g.us');
  });

  it('converts phone to JID', () => {
    const { ctx } = mockCommsCtx();
    expect(resolveWaTarget({ phone: '15551234567' }, ctx)).toBe('15551234567@s.whatsapp.net');
  });

  it('falls back to notifyJid then ownJid', () => {
    const { ctx } = mockCommsCtx({ notifyJid: '99999@s.whatsapp.net' });
    expect(resolveWaTarget({}, ctx)).toBe('99999@s.whatsapp.net');

    const { ctx: ctx2 } = mockCommsCtx({ notifyJid: null });
    expect(resolveWaTarget({}, ctx2)).toBe('15551234567@s.whatsapp.net');
  });

  it('returns null when no resolution', () => {
    const { ctx } = mockCommsCtx({ ownJid: '', notifyJid: null });
    // Override ownJid to return empty
    ctx.ownJid = () => null;
    expect(resolveWaTarget({}, ctx)).toBeNull();
  });
});

// ────── 6. handleWaSendMedia — production handler ──────

describe('handleWaSendMedia — production handler', () => {
  let tmpCwd: string;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'wa-handler-'));
    mkdirSync(join(tmpCwd, '.continuum', 'Attachment'), { recursive: true });
  });
  afterEach(() => { rmSync(tmpCwd, { recursive: true, force: true }); });

  it('stages a file and delivers exact bytes/kind/mime/fileName/caption to the mock client', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'screenshot.png'), pngBytes);

    const { ctx, client } = mockCommsCtx({ canSendOthers: true });

    const result = await handleWaSendMedia(
      { chatId: '120363423190535250@g.us', path: 'screenshot.png', caption: 'Build output' },
      ctx, tmpCwd,
    );

    expect(result.content[0].text).toContain('Sent');
    expect(result.content[0].text).toContain('screenshot.png');
    expect(result.content[0].text).toContain('image');
    expect(result.content[0].text).toContain('8 bytes');

    // Verify the mock client received EXACT bytes and metadata
    expect(client.mediaCalls).toHaveLength(1);
    const call = client.mediaCalls[0];
    expect(call.chatId).toBe('120363423190535250@g.us');
    const media = call.media as { kind: string; data: Buffer; mimetype: string; fileName: string; caption: string };
    expect(media.kind).toBe('image');
    expect(media.mimetype).toBe('image/png');
    expect(media.fileName).toBe('screenshot.png');
    expect(media.caption).toBe('Build output');
    expect(Buffer.compare(media.data, pngBytes)).toBe(0);
  });

  it('uses the same target cascade as wa_send_message', async () => {
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'x.txt'), 'data');
    const { ctx, client } = mockCommsCtx({ notifyJid: '99999@s.whatsapp.net' });
    // No chatId/phone → falls back to notifyJid
    const result = await handleWaSendMedia({ path: 'x.txt' }, ctx, tmpCwd);
    expect(result.content[0].text).toContain('99999@s.whatsapp.net');
    expect(client.mediaCalls[0].chatId).toBe('99999@s.whatsapp.net');
  });

  it('blocks media to non-self when canSendOthers is false', async () => {
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'x.txt'), 'data');
    const { ctx } = mockCommsCtx({ canSendOthers: false });
    const result = await handleWaSendMedia(
      { chatId: '120363423190535250@g.us', path: 'x.txt' }, ctx, tmpCwd,
    );
    expect(result.content[0].text).toContain('Blocked');
  });

  it('returns actionable error for missing file', async () => {
    const { ctx } = mockCommsCtx();
    const result = await handleWaSendMedia(
      { chatId: '15551234567@s.whatsapp.net', path: 'ghost.png' }, ctx, tmpCwd,
    );
    expect(result.content[0].text).toContain('Attachment rejected');
  });

  it('returns error for traversal attempt without echoing the path', async () => {
    writeFileSync(join(tmpCwd, '.continuum', 'secret.txt'), 'private');
    const { ctx } = mockCommsCtx();
    const result = await handleWaSendMedia(
      { chatId: '15551234567@s.whatsapp.net', path: '../secret.txt' }, ctx, tmpCwd,
    );
    expect(result.content[0].text).toContain('Attachment rejected');
    expect(result.content[0].text).not.toContain(tmpCwd);
  });

  it('rejects an in-root symlink (link.txt -> real.txt both inside Attachment/) before sendMedia, no path leak', async () => {
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'real.txt'), 'real content');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(
      join(tmpCwd, '.continuum', 'Attachment', 'real.txt'),
      join(tmpCwd, '.continuum', 'Attachment', 'link.txt'),
    );
    const { ctx, client } = mockCommsCtx();
    const result = await handleWaSendMedia(
      { chatId: '15551234567@s.whatsapp.net', path: 'link.txt' }, ctx, tmpCwd,
    );
    expect(result.content[0].text).toContain('Attachment rejected');
    expect(result.content[0].text).not.toContain(tmpCwd);
    expect(result.content[0].text).not.toContain('real.txt');
    expect(client.mediaCalls).toHaveLength(0); // sendMedia never called
  });

  it('returns error when no recipient', async () => {
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'x.txt'), 'data');
    const { ctx } = mockCommsCtx({ ownJid: '', notifyJid: null });
    ctx.ownJid = () => null;
    const result = await handleWaSendMedia({ path: 'x.txt' }, ctx, tmpCwd);
    expect(result.content[0].text).toContain('No recipient');
  });

  it('success result contains only recipient + basename + kind + byte count (no raw path)', async () => {
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'report.pdf'), Buffer.alloc(42));
    const { ctx } = mockCommsCtx();
    const result = await handleWaSendMedia(
      { chatId: '15551234567@s.whatsapp.net', path: 'report.pdf' }, ctx, tmpCwd,
    );
    const text = result.content[0].text;
    expect(text).toContain('15551234567@s.whatsapp.net');
    expect(text).toContain('report.pdf');
    expect(text).toContain('document');
    expect(text).toContain('42 bytes');
    expect(text).not.toContain(tmpCwd);
    expect(text).not.toContain('.continuum');
  });

  it('END-TO-END: registered wa_send_media tool handler delivers exact bytes/metadata via buildWaTools', async () => {
    // This test validates the production registration path: buildWaTools() → SDK tool() → handler invocation.
    // Must fail if wa_send_media is registered with wrong schema/handler, omitted, or disconnected.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'output.png'), pngBytes);

    const { ctx, client } = mockCommsCtx({ canSendOthers: true });

    // Capture registered tool handlers via fake SDK tool()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
    const fakeTool = (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      handlers[name] = handler as typeof handlers[string];
      return { name };
    };
    const fakeWrap = (fn: unknown) => fn;

    buildWaTools({ tool: fakeTool, wrap: fakeWrap, commsCtx: ctx, cwd: tmpCwd });

    // Verify wa_send_media is registered and in canonical list
    expect(handlers['wa_send_media']).toBeDefined();
    expect(WA_TOOL_NAMES).toContain('wa_send_media');

    // Invoke the CAPTURED registered handler (not handleWaSendMedia directly)
    const result = await handlers['wa_send_media']({
      chatId: '120363423190535250@g.us',
      path: 'output.png',
      caption: 'Build complete',
    });

    // Assert mocked sendMedia received exact bytes/metadata
    expect(client.mediaCalls).toHaveLength(1);
    const call = client.mediaCalls[0];
    expect(call.chatId).toBe('120363423190535250@g.us');
    const media = call.media as { kind: string; data: Buffer; mimetype: string; fileName: string; caption: string };
    expect(media.kind).toBe('image');
    expect(media.mimetype).toBe('image/png');
    expect(media.fileName).toBe('output.png');
    expect(media.caption).toBe('Build complete');
    expect(Buffer.compare(media.data, pngBytes)).toBe(0);

    // Assert safe success result (basename/kind/bytes/recipient, no absolute path)
    const text = result.content[0].text;
    expect(text).toContain('Sent');
    expect(text).toContain('image');
    expect(text).toContain('output.png');
    expect(text).toContain('8 bytes');
    expect(text).toContain('120363423190535250@g.us');
    expect(text).not.toContain(tmpCwd);
    expect(text).not.toContain('.continuum');
  });
});

// ────── 7. waSendAllowed gates media the same as text ──────

describe('waSendAllowed gates', () => {
  it('own number always allowed', () => {
    expect(waSendAllowed('15551234567@s.whatsapp.net', ['15551234567@s.whatsapp.net'], false)).toBe(true);
  });

  it('other number blocked unless canSendOthers', () => {
    expect(waSendAllowed('99999@s.whatsapp.net', ['15551234567@s.whatsapp.net'], false)).toBe(false);
    expect(waSendAllowed('99999@s.whatsapp.net', ['15551234567@s.whatsapp.net'], true)).toBe(true);
  });

  it('group JID allowed only when canSendOthers', () => {
    expect(waSendAllowed('120363423190535250@g.us', ['15551234567@s.whatsapp.net'], false)).toBe(false);
    expect(waSendAllowed('120363423190535250@g.us', ['15551234567@s.whatsapp.net'], true)).toBe(true);
  });
});

// ────── 8. Text sending unchanged (regression) ──────

describe('text sending regression', () => {
  it('sendText still works and stores kind=text', async () => {
    const s = new Store();
    const { sock, sent, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('connection.update', { connection: 'open' });

    const ok = await client.sendText('111@s.whatsapp.net', 'hello text');
    expect(ok).toBe(true);
    expect(sent[0].content.text).toBe('hello text');
    expect(s.waMessages('111@s.whatsapp.net').at(-1)!.kind).toBe('text');
  });
});

// ────── 9. recordContextSend — quote-reply routing callback ──────

describe('recordContextSend — context-project routing', () => {
  let tmpCwd: string;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'wa-rcs-'));
    mkdirSync(join(tmpCwd, '.continuum', 'Attachment'), { recursive: true });
  });
  afterEach(() => { rmSync(tmpCwd, { recursive: true, force: true }); });

  it('wa_send_message calls recordContextSend once on success', async () => {
    const spy = vi.fn();
    const { ctx } = mockCommsCtx({ recordContextSend: spy });
    // Build tools and extract the wa_send_message handler
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
    const fakeTool = (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      handlers[name] = handler as typeof handlers[string]; return { name };
    };
    const fakeWrap = (fn: unknown) => fn;
    buildWaTools({ tool: fakeTool, wrap: fakeWrap, commsCtx: ctx, cwd: tmpCwd });

    await handlers['wa_send_message']({ chatId: '15551234567@s.whatsapp.net', text: 'hello' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('15551234567@s.whatsapp.net', 'hello');
  });

  it('wa_send_message does NOT call recordContextSend when send fails', async () => {
    const spy = vi.fn();
    const failClient = mockWaClient();
    failClient.sendText = async () => false;
    const { ctx } = mockCommsCtx({ recordContextSend: spy, client: failClient });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
    const fakeTool = (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      handlers[name] = handler as typeof handlers[string]; return { name };
    };
    buildWaTools({ tool: fakeTool, wrap: (fn: unknown) => fn, commsCtx: ctx, cwd: tmpCwd });

    await handlers['wa_send_message']({ chatId: '15551234567@s.whatsapp.net', text: 'fail' });

    expect(spy).not.toHaveBeenCalled();
  });

  it('wa_send_message does NOT call recordContextSend when blocked', async () => {
    const spy = vi.fn();
    const { ctx } = mockCommsCtx({ canSendOthers: false, recordContextSend: spy });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
    const fakeTool = (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      handlers[name] = handler as typeof handlers[string]; return { name };
    };
    buildWaTools({ tool: fakeTool, wrap: (fn: unknown) => fn, commsCtx: ctx, cwd: tmpCwd });

    // Send to a non-self JID without canSendOthers → blocked
    await handlers['wa_send_message']({ chatId: '99999@g.us', text: 'blocked' });

    expect(spy).not.toHaveBeenCalled();
  });

  it('handleWaSendMedia calls recordContextSend once for captioned success', async () => {
    const spy = vi.fn();
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'img.png'), Buffer.from([0x89, 0x50]));
    const { ctx } = mockCommsCtx({ canSendOthers: true, recordContextSend: spy });

    await handleWaSendMedia(
      { chatId: '120363423190535250@g.us', path: 'img.png', caption: 'Build output' },
      ctx, tmpCwd,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('120363423190535250@g.us', 'Build output');
  });

  it('handleWaSendMedia does NOT call recordContextSend for captionless send', async () => {
    const spy = vi.fn();
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'img.png'), Buffer.from([0x89, 0x50]));
    const { ctx } = mockCommsCtx({ canSendOthers: true, recordContextSend: spy });

    await handleWaSendMedia(
      { chatId: '120363423190535250@g.us', path: 'img.png' }, // no caption
      ctx, tmpCwd,
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('handleWaSendMedia does NOT call recordContextSend when blocked', async () => {
    const spy = vi.fn();
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'img.png'), Buffer.from([0x89, 0x50]));
    const { ctx } = mockCommsCtx({ canSendOthers: false, recordContextSend: spy });

    await handleWaSendMedia(
      { chatId: '120363423190535250@g.us', path: 'img.png', caption: 'blocked' },
      ctx, tmpCwd,
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('handleWaSendMedia does NOT call recordContextSend when file missing', async () => {
    const spy = vi.fn();
    const { ctx } = mockCommsCtx({ recordContextSend: spy });

    await handleWaSendMedia(
      { chatId: '15551234567@s.whatsapp.net', path: 'ghost.png', caption: 'missing' },
      ctx, tmpCwd,
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('wa_send_message still reports success when recordContextSend throws', async () => {
    const throwingSpy = vi.fn(() => { throw new Error('bookkeeping failure'); });
    const { ctx } = mockCommsCtx({ recordContextSend: throwingSpy });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
    const fakeTool = (name: string, _desc: string, _schema: unknown, handler: unknown) => {
      handlers[name] = handler as typeof handlers[string]; return { name };
    };
    buildWaTools({ tool: fakeTool, wrap: (fn: unknown) => fn, commsCtx: ctx, cwd: tmpCwd });

    const result = await handlers['wa_send_message']({ chatId: '15551234567@s.whatsapp.net', text: 'hello' });

    expect(throwingSpy).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Sent');
  });

  it('handleWaSendMedia still reports success when recordContextSend throws', async () => {
    const throwingSpy = vi.fn(() => { throw new Error('bookkeeping failure'); });
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'img.png'), Buffer.from([0x89, 0x50]));
    const { ctx } = mockCommsCtx({ canSendOthers: true, recordContextSend: throwingSpy });

    const result = await handleWaSendMedia(
      { chatId: '120363423190535250@g.us', path: 'img.png', caption: 'Build output' },
      ctx, tmpCwd,
    );

    expect(throwingSpy).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Sent');
  });

  it('handleWaSendMedia does NOT call recordContextSend for whitespace-only caption', async () => {
    const spy = vi.fn();
    writeFileSync(join(tmpCwd, '.continuum', 'Attachment', 'img.png'), Buffer.from([0x89, 0x50]));
    const { ctx } = mockCommsCtx({ canSendOthers: true, recordContextSend: spy });

    await handleWaSendMedia(
      { chatId: '120363423190535250@g.us', path: 'img.png', caption: '   \t\n  ' },
      ctx, tmpCwd,
    );

    expect(spy).not.toHaveBeenCalled();
  });
});
