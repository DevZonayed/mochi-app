/* Mirror store tests — pure unit tests against the in-memory backend.
   The Postgres backend has the same contract, so passing here is a strong
   signal it will work against Postgres too (we still exercise the PG layer
   manually + in staging before production). */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryMirrorStore,
  createInMemoryMirrorStore,
  type MirrorStore,
} from './mirrorStore.js';

describe('InMemoryMirrorStore', () => {
  let store: MirrorStore;
  beforeEach(() => { store = createInMemoryMirrorStore(); });

  it('upserts a chat and reads it back via listChats + getChat', async () => {
    const rec = await store.upsertChat({ id: 'c1', projectId: 'p1', title: 'Hello' });
    expect(rec.id).toBe('c1');
    expect(rec.accountId).toBe('self');
    expect(rec.projectId).toBe('p1');
    expect(rec.title).toBe('Hello');
    expect(rec.archived).toBe(false);

    const list = await store.listChats('self', 'p1');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('c1');

    const one = await store.getChat('c1');
    expect(one?.title).toBe('Hello');
  });

  it('upsertChat preserves createdAt across updates', async () => {
    const a = await store.upsertChat({ id: 'c1', title: 'V1' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.upsertChat({ id: 'c1', title: 'V2' });
    expect(b.createdAt).toBe(a.createdAt);
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
    expect(b.title).toBe('V2');
  });

  it('upsertMessages writes the messages and bumps the chat updatedAt', async () => {
    const chat = await store.upsertChat({ id: 'c1', title: 'Conv' });
    const written = await store.upsertMessages([
      { id: 'm1', chatId: 'c1', role: 'user',      content: 'hi',    createdAt: chat.updatedAt + 10 },
      { id: 'm2', chatId: 'c1', role: 'assistant', content: 'hello', createdAt: chat.updatedAt + 20 },
    ]);
    expect(written).toBe(2);
    const reread = await store.getChat('c1');
    expect(reread?.updatedAt).toBe(chat.updatedAt + 20);
  });

  it('listMessages returns oldest-first, newest at the bottom, paginated', async () => {
    await store.upsertChat({ id: 'c1' });
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, chatId: 'c1', role: 'user' as const, content: `msg-${i}`, createdAt: 1000 + i,
    }));
    await store.upsertMessages(msgs);
    const page = await store.listMessages('c1', { limit: 3 });
    // Newest-3 returned in chronological order (oldest of the slice first).
    expect(page.messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
    expect(page.hasMore).toBe(true);
  });

  it('listMessages with `beforeCreatedAt` pages backwards', async () => {
    await store.upsertChat({ id: 'c1' });
    await store.upsertMessages(Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, chatId: 'c1', role: 'user' as const, content: `msg-${i}`, createdAt: 1000 + i,
    })));
    const first = await store.listMessages('c1', { limit: 2 });
    expect(first.messages.map((m) => m.id)).toEqual(['m3', 'm4']);
    const second = await store.listMessages('c1', { limit: 2, beforeCreatedAt: first.messages[0].createdAt });
    expect(second.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(second.hasMore).toBe(true);
  });

  it('upsertMemory(kind=state) is a single row per project', async () => {
    await store.upsertMemory({ projectId: 'p1', kind: 'state', content: 'first' });
    await store.upsertMemory({ projectId: 'p1', kind: 'state', content: 'second' });
    const mems = await store.listMemories('self', 'p1');
    expect(mems).toHaveLength(1);
    expect(mems[0].content).toBe('second');
    expect(mems[0].kind).toBe('state');
  });

  it('upsertMemory(kind=checkpoint) uses commitSha so each checkpoint is its own row', async () => {
    await store.upsertMemory({ projectId: 'p1', kind: 'checkpoint', content: 'cp1', commitSha: 'aaa' });
    await store.upsertMemory({ projectId: 'p1', kind: 'checkpoint', content: 'cp2', commitSha: 'bbb' });
    await store.upsertMemory({ projectId: 'p1', kind: 'state', content: 'state-now' });
    const mems = await store.listMemories('self', 'p1');
    expect(mems).toHaveLength(3);
    // Default ids are account-namespaced so two accounts can mirror the same
    // project without trampling each other (see defaultMemoryId in mirrorStore.ts).
    expect(new Set(mems.map((m) => m.id))).toEqual(new Set(['self:p1:state', 'self:p1:aaa', 'self:p1:bbb']));
  });

  it('listChats filters by projectId when supplied', async () => {
    await store.upsertChat({ id: 'a', projectId: 'p1' });
    await store.upsertChat({ id: 'b', projectId: 'p2' });
    await store.upsertChat({ id: 'c', projectId: null });
    const inP1 = await store.listChats('self', 'p1');
    expect(inP1.map((c) => c.id)).toEqual(['a']);
    const workspace = await store.listChats('self', null);
    expect(workspace.map((c) => c.id)).toEqual(['c']);
    const all = await store.listChats('self');
    expect(all.map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('respects accountId boundary in listChats and listMemories', async () => {
    await store.upsertChat({ id: 'mine',  accountId: 'self',  projectId: 'p1' });
    await store.upsertChat({ id: 'yours', accountId: 'other', projectId: 'p1' });
    const mine = await store.listChats('self', 'p1');
    expect(mine.map((c) => c.id)).toEqual(['mine']);
    await store.upsertMemory({ accountId: 'self',  projectId: 'p1', kind: 'state', content: 'mine' });
    await store.upsertMemory({ accountId: 'other', projectId: 'p1', kind: 'state', content: 'yours' });
    const memMine = await store.listMemories('self', 'p1');
    expect(memMine.map((m) => m.content)).toEqual(['mine']);
  });

  it('clear() wipes everything', async () => {
    await store.upsertChat({ id: 'c1' });
    await store.upsertMessages([{ id: 'm1', chatId: 'c1', role: 'user', content: 'hi' }]);
    await store.upsertMemory({ projectId: 'p1', kind: 'state', content: 'x' });
    await store.clear();
    expect(await store.listChats('self')).toHaveLength(0);
    expect((await store.listMessages('c1')).messages).toHaveLength(0);
    expect(await store.listMemories('self', 'p1')).toHaveLength(0);
  });

  it('createInMemoryMirrorStore returns a fresh InMemoryMirrorStore', () => {
    const s = createInMemoryMirrorStore();
    expect(s).toBeInstanceOf(InMemoryMirrorStore);
  });
});
