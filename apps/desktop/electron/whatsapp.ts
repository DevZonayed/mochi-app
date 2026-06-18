/* WhatsApp — a real channel over WhatsApp Web (Baileys), running ON THIS MAC
   (the brain), mirroring telegram.ts. Link by scanning a QR in the Comms screen;
   from then on EVERY message (live + whatever history WhatsApp pushes on link)
   is captured and appended to a per-chat messages.jsonl history store. Capture
   only in v1 — no sending, no job-binding yet.

   Baileys is heavy and uses dynamic requires, so it's marked `external` in the
   electron-main build and lazily imported inside open() — the app boots fine
   without WhatsApp ever being linked. Auth (the linked-device creds) lives in
   userData/whatsapp-auth, kept OUTSIDE the message-history root so clearing
   history never logs the device out. */

import { app } from 'electron';
import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
import { normalizeWaMessage } from './waNormalize.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySock = any;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECTS = 6;
// Close codes that must NOT auto-reconnect (session permanently invalid):
// loggedOut(401), connectionReplaced(440), badSession(500).
const NO_RECONNECT = new Set([401, 440, 500]);

/* pino-shaped logger shim Baileys expects, forwarded to the Electron console.
   (We deliberately do not add pino as a dependency — same call as the reference.) */
function consoleLogger(level = 'warn'): any {
  const mk = (lvl: string) => (...args: any[]) => { if (lvl === 'error' || lvl === 'fatal') console.error('[wa]', ...args); };
  const logger: any = { level, trace: mk('trace'), debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), fatal: mk('fatal') };
  logger.child = () => logger;
  return logger;
}

export class WhatsAppBot {
  private sock: AnySock | null = null;
  private connecting = false;
  private reconnects = 0;
  private stopped = false;
  private logger = consoleLogger();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private store: Store, private emit: (name: string, data: unknown) => void) {}

  private authDir(): string { return join(app.getPath('userData'), 'whatsapp-auth'); }
  private emitStatus(): void {
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    this.emit('comms', this.store.commsStatus());
  }
  /* Coalesce capture-driven status pushes — a history backfill can append
     hundreds of messages at once, and one 'comms' event per message would storm
     the renderer with refetches. Connection/QR changes still emit immediately. */
  private scheduleStatus(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.emit('comms', this.store.commsStatus()); }, 400);
  }

  /** Begin (or restart) linking: build a socket. The QR string arrives through
      'comms' events; the account flips to connected once it reaches 'open'. */
  async connect(): Promise<void> {
    if (this.connecting || this.sock) return;
    this.stopped = false;
    this.reconnects = 0;
    await this.open();
  }

  private async open(): Promise<void> {
    this.connecting = true;
    try {
      const baileys: any = await import('@whiskeysockets/baileys');
      const makeWASocket = baileys.default || baileys.makeWASocket;
      const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
      await mkdir(this.authDir(), { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir());
      let version: unknown;
      try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }
      const sock = makeWASocket({
        version,
        auth: state,
        logger: this.logger,
        printQRInTerminal: false,
        syncFullHistory: false,
        // Always pass an explicit callback — syncFullHistory:false alone silently
        // kills history sync and can break live routing (reference §5.2 trap).
        shouldSyncHistoryMessage: () => true,
        getMessage: async () => undefined,
      });
      this.sock = sock;
      sock.ev.on('creds.update', saveCreds);
      this.wireCapture(sock);
      this.wireConnection(sock);
    } catch (e) {
      this.logger.error('open failed', String(e));
    } finally {
      this.connecting = false;
    }
  }

  private wireCapture(sock: AnySock): void {
    sock.ev.on('messages.upsert', (payload: any) => {
      for (const raw of payload?.messages || []) this.capture(raw, 'live');
    });
    sock.ev.on('messaging-history.set', (payload: any) => {
      for (const raw of payload?.messages || []) this.capture(raw, 'backfill');
    });
  }

  private capture(raw: any, source: 'live' | 'backfill'): void {
    let msg;
    try { msg = normalizeWaMessage(raw, source); } catch { return; }
    if (!msg) return;
    let appended = false;
    try { appended = this.store.appendWaMessage(msg); } catch { return; }
    if (appended) this.scheduleStatus();
  }

  private statusCode(update: any): number | null {
    return update?.lastDisconnect?.error?.output?.statusCode
      ?? update?.lastDisconnect?.error?.output?.payload?.statusCode
      ?? null;
  }

  private wireConnection(sock: AnySock): void {
    sock.ev.on('connection.update', async (update: any) => {
      if (update.qr) { this.store.setWhatsappQr(update.qr); this.emitStatus(); }

      if (update.connection === 'open') {
        this.reconnects = 0;
        this.store.setWhatsappQr(null);
        const jid: string | null = sock?.user?.id ?? null;
        const name: string | null = sock?.user?.name ?? sock?.user?.verifiedName ?? sock?.user?.notify ?? null;
        this.store.setWhatsappState({ connected: true, jid, name, connectedAt: Date.now() });
        this.emitStatus();
        return;
      }

      if (update.connection === 'close') {
        if (this.sock !== sock) return; // a newer socket (reconnect/unlink) owns the account now
        this.sock = null;
        this.store.setWhatsappQr(null);
        const code = this.statusCode(update);

        if (code === 401) { // logged out elsewhere — wipe creds, require a fresh QR
          this.store.setWhatsappState({ connected: false, jid: null, name: null, connectedAt: null });
          await this.wipeAuth();
          this.emitStatus();
          return;
        }
        if (code != null && NO_RECONNECT.has(code)) {
          this.store.setWhatsappState({ connected: false });
          this.emitStatus();
          return;
        }
        // restartRequired / connectionClosed / connectionLost / transient: bounded
        // reconnect with exponential backoff (a socket is single-use after close).
        this.store.setWhatsappState({ connected: false });
        this.emitStatus();
        if (this.stopped) return;
        const attempts = ++this.reconnects;
        if (attempts > MAX_RECONNECTS) { this.logger.warn('reconnect limit reached'); return; }
        await sleep(Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS));
        if (!this.stopped && !this.sock) this.open().catch(() => {});
      }
    });
  }

  /** Unlink the device: log out, wipe creds, drop connection state. Message
      history is intentionally KEPT (the whole point is the history). */
  async disconnect(): Promise<void> {
    this.stopped = true;
    const sock = this.sock;
    this.sock = null;
    try { await sock?.logout?.(); } catch { /* may already be closed */ }
    try { sock?.end?.(undefined); } catch { /* ignore */ }
    await this.wipeAuth();
    this.store.setWhatsappQr(null);
    this.store.setWhatsappState({ connected: false, jid: null, name: null, connectedAt: null });
    this.emitStatus();
  }

  /** Reconnect on app launch if a linked session already exists. */
  resumeOnBoot(): void {
    if (existsSync(join(this.authDir(), 'creds.json'))) this.connect().catch(() => {});
  }

  /** App quit — close the socket but keep auth + history for next launch. */
  stop(): void {
    this.stopped = true;
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    try { this.sock?.end?.(undefined); } catch { /* ignore */ }
    this.sock = null;
  }

  private async wipeAuth(): Promise<void> {
    try { await rm(this.authDir(), { recursive: true, force: true }); } catch { /* nothing to wipe */ }
  }
}
