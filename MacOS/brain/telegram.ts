/* Telegram bot — a real remote control over the Telegram Bot API (plain fetch
   long-polling, no SDK). The bot token is validated via getMe and stored
   encrypted (safeStorage). A single-flight poll loop reads getUpdates with a 25s
   long-poll; the update offset is persisted BEFORE handling each update, so a
   crash can never replay a message (at-most-once). Unknown chats land in a
   pending list; once an operator binds a chat (with permissions), it can start
   jobs and approve gates from Telegram — all executing on this Mac. The token
   never enters the relay snapshot. */

import { powerMonitor } from 'electron';
import type { Store, Approval } from './store.js';
import type { LocalEngine } from './engine.js';
import type { Providers } from './providers.js';

const KEY = 'telegram';
const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const clip = (s: string, n = 3500) => (s.length > n ? s.slice(0, n) + '…' : s);

interface TgChat { id: number; type: string; title?: string; username?: string; first_name?: string }
interface TgMessage { message_id: number; chat: TgChat; text?: string; from?: { username?: string; first_name?: string } }
interface TgCallback { id: string; data?: string; message?: TgMessage; from?: { username?: string; first_name?: string } }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }

function chatName(c: TgChat): string {
  return c.title || c.username || c.first_name || `chat ${c.id}`;
}

export class TelegramBot {
  private polling = false;
  private abort: AbortController | null = null;

  constructor(private store: Store, private engine: LocalEngine, private providers: Providers, private emit: (name: string, data: unknown) => void) {
    powerMonitor.on('resume', () => { if (this.providers.getRawKey(KEY)) this.start(); });
    powerMonitor.on('suspend', () => this.abort?.abort());
  }

  status() { return this.store.commsStatus(); }

  private async tg<T = unknown>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; result?: T; error_code?: number; description?: string }> {
    const token = this.providers.getRawKey(KEY);
    if (!token) return { ok: false, description: 'not connected' };
    const res = await fetch(API(token, method), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    return await res.json() as { ok: boolean; result?: T };
  }

  private send(chatId: number | string, text: string, reply_markup?: unknown) {
    void this.tg('sendMessage', { chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) }).catch(() => {});
  }

  /** Validate a token, store it encrypted, and start polling. */
  async connect(token: string): Promise<{ username: string }> {
    const t = token.trim();
    if (!t) throw Object.assign(new Error('a bot token is required'), { statusCode: 400 });
    const res = await fetch(API(t, 'getMe'));
    const j = await res.json() as { ok: boolean; result?: { username?: string } };
    if (!j.ok || !j.result?.username) throw Object.assign(new Error('Invalid bot token — check it with @BotFather.'), { statusCode: 400 });
    this.providers.setRawKey(KEY, t);
    this.store.setTelegramState({ botUsername: j.result.username, connectedAt: Date.now() });
    this.emit('comms', this.store.commsStatus());
    this.start();
    return { username: j.result.username };
  }

  disconnect(): void {
    this.stop();
    this.providers.clearKey(KEY);
    this.store.setTelegramState({ botUsername: null, connectedAt: null });
    this.emit('comms', this.store.commsStatus());
  }

  resumeOnBoot(): void { if (this.providers.getRawKey(KEY)) this.start(); }

  start(): void { if (!this.polling) { this.polling = true; void this.loop(); } }
  stop(): void { this.polling = false; this.abort?.abort(); }

  private async loop(): Promise<void> {
    while (this.polling) {
      const token = this.providers.getRawKey(KEY);
      if (!token) { this.polling = false; break; }
      try {
        const offset = this.store.telegramState().offset;
        this.abort = new AbortController();
        const cap = setTimeout(() => this.abort?.abort(), 35_000);
        const res = await fetch(`${API(token, 'getUpdates')}?offset=${offset}&timeout=25&allowed_updates=["message","callback_query"]`, { signal: this.abort.signal });
        clearTimeout(cap);
        if (res.status === 409) { await sleep(3000); continue; } // another poller — back off
        if (!res.ok) { await sleep(2000); continue; }
        const j = await res.json() as { ok: boolean; result?: TgUpdate[] };
        for (const u of j.result ?? []) {
          // Persist the offset BEFORE handling → at-most-once on crash.
          this.store.setTelegramState({ offset: u.update_id + 1 });
          try { await this.handle(token, u); } catch { /* one bad update shouldn't stop the loop */ }
        }
      } catch {
        if (!this.polling) break;
        await sleep(2000);
      }
    }
  }

  private async handle(_token: string, u: TgUpdate): Promise<void> {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    const msg = u.message;
    if (!msg || !msg.chat) return;
    const chatId = msg.chat.id;
    const text = (msg.text ?? '').trim();
    const binding = this.store.getChatBinding(String(chatId));

    this.store.addCommEvent({ dir: 'in', chatId: String(chatId), chatName: chatName(msg.chat), payload: text.slice(0, 500), status: 'received' });
    this.emit('comms', this.store.commsStatus());

    if (!binding) {
      this.store.upsertPendingChat({ chatId: String(chatId), name: chatName(msg.chat), kind: msg.chat.type === 'private' ? 'dm' : 'group', firstText: text.slice(0, 200) });
      this.emit('comms', this.store.commsStatus());
      this.reply(chatId, `👋 This chat isn’t linked to Maestro yet. Open Maestro → Comms on your Mac to bind it, then send /run <task>.`);
      return;
    }

    if (text === '/gates' || text === '/gates@') return this.sendGates(chatId, binding.permissions.approveGates);

    if (text.startsWith('/run') || (text && !text.startsWith('/'))) {
      if (!binding.permissions.startJobs) { this.reply(chatId, 'This chat isn’t allowed to start jobs. Enable it in Maestro → Comms.'); return; }
      const prompt = text.startsWith('/run') ? text.slice(4).trim() : text;
      if (!prompt) { this.reply(chatId, 'Send /run followed by what you want done.'); return; }
      const project = (binding.projectId ? this.store.getProject(binding.projectId) : undefined) ?? this.store.listProjects()[0];
      if (!project) { this.reply(chatId, 'No project to run in yet. Create one in Maestro first.'); return; }
      const job = this.store.createJob(project.id, prompt, `Telegram: ${prompt.slice(0, 40)}`, 'balanced');
      this.emit('job', job);
      this.reply(chatId, `▶️ On it — running in ${project.name}…`);
      void this.engine.run(job.id).then(done => {
        if (binding.permissions.receiveReports) {
          const body = done.status === 'done' ? (done.output ?? '(no output)') : `❌ ${done.error ?? 'failed'}`;
          this.reply(chatId, clip(`${done.status === 'done' ? '✅' : '⚠️'} ${job.title}\n\n${body}`));
        }
      }).catch(() => {});
      return;
    }

    if (text === '/start' || text === '/help') { this.reply(chatId, 'Maestro bot. Commands:\n/run <task> — start a job on your Mac\n/gates — review pending approvals'); return; }
    this.reply(chatId, 'Unknown command. Try /run <task> or /gates.');
  }

  private sendGates(chatId: number, canApprove: boolean): void {
    const pending = this.store.listApprovals('pending');
    if (pending.length === 0) { this.reply(chatId, '✅ No approvals waiting.'); return; }
    for (const a of pending.slice(0, 6)) {
      const reply_markup = canApprove ? { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve:${a.id}` }, { text: '✖️ Deny', callback_data: `deny:${a.id}` }]] } : undefined;
      this.send(chatId, clip(`🚦 ${a.title}\n${a.subtitle || ''}\n\n${a.detail || ''}`, 1200), reply_markup);
    }
    if (!canApprove) this.reply(chatId, 'This chat can view gates but not approve. Enable “Approve gates” in Maestro → Comms.');
  }

  private async handleCallback(cb: TgCallback): Promise<void> {
    const data = cb.data ?? '';
    const m = /^(approve|deny):(.+)$/.exec(data);
    const chatId = cb.message?.chat.id;
    const binding = chatId != null ? this.store.getChatBinding(String(chatId)) : undefined;
    if (!m || !binding?.permissions.approveGates) {
      await this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not allowed here.' });
      return;
    }
    const [, action, id] = m;
    try {
      const resolved = this.store.resolveApproval(id, action === 'approve' ? 'approved' : 'denied');
      this.emit('approval', resolved);
      this.store.pushEvent({ kind: 'approval-resolved', title: `${action === 'approve' ? 'Approved' : 'Denied'} via Telegram: ${resolved.title}`, projectId: resolved.projectId, jobId: resolved.jobId ?? undefined });
      await this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: action === 'approve' ? 'Approved ✅' : 'Denied ✖️' });
      if (chatId != null && cb.message) await this.tg('editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: `${action === 'approve' ? '✅ Approved' : '✖️ Denied'}: ${resolved.title}` });
      this.store.addCommEvent({ dir: 'in', chatId: String(chatId), chatName: binding.name, payload: `${action} ${resolved.title}`, status: 'received' });
      this.emit('comms', this.store.commsStatus());
    } catch {
      await this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already resolved.' });
    }
  }

  private reply(chatId: number, text: string): void {
    this.send(chatId, text);
    this.store.addCommEvent({ dir: 'out', chatId: String(chatId), chatName: this.store.getChatBinding(String(chatId))?.name ?? String(chatId), payload: text.slice(0, 500), status: 'sent' });
    this.emit('comms', this.store.commsStatus());
  }

  /** Push a newly-created approval gate to every bound chat that can approve. */
  notifyApproval(a: Approval): void {
    if (a.status !== 'pending') return;
    if (!this.providers.getRawKey(KEY)) return;
    for (const b of this.store.listChatBindings()) {
      if (!b.permissions.approveGates) continue;
      const reply_markup = { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve:${a.id}` }, { text: '✖️ Deny', callback_data: `deny:${a.id}` }]] };
      this.send(b.chatId, clip(`🚦 New approval: ${a.title}\n${a.subtitle || ''}`, 1000), reply_markup);
    }
  }
}
