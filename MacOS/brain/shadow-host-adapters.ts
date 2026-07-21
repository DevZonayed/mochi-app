/**
 * shadow-host-adapters — Phase 3A2a PRODUCTION adapters for the desktop host
 * enrollment runtime on the maintained macOS **WebKit** app.
 *
 *  - {@link SafeStorageVault} bridges the runtime's injected `SecureVault` seam to
 *    the real `electron.safeStorage` API. In the WebKit sidecar that API is the
 *    MS1 AES-256-GCM envelope keyed by the Swift Security.framework channel-scoped
 *    Keychain master key (see `sidecar/src/electron-shim.ts` +
 *    `webview-app/Sources/MaestroWebKit/main.swift`). Only ENCRYPTED envelope bytes
 *    ever leave this adapter; it fails closed when `isEncryptionAvailable()` is
 *    false or a decrypt/auth check fails, and never exposes the master key or the
 *    decrypted private bytes beyond the return value the trusted runtime consumes.
 *  - {@link FileHostEnrollmentPersistence} stores the runtime's PUBLIC record
 *    (plus already-vault-encrypted identity/scope ciphertext blobs — never
 *    plaintext) atomically under channel-scoped userData with mode 0600, with
 *    bounded size + malformed-row recovery (quarantine + re-init).
 *
 * Both are injected into `ShadowHostEnrollmentRuntime`; tests exercise the real
 * classes with a mocked safeStorage at the platform seam only.
 */
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecureVault, HostEnrollmentPersistence, HostEnrollmentRecord } from './shadow-enrollment-host.js';

/** The subset of `electron.safeStorage` this adapter uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Uint8Array;
  decryptString(ciphertext: Uint8Array): string;
}

/**
 * `SecureVault` backed by the real OS-vault `safeStorage`. Encryption unavailable
 * (locked/missing Keychain master key) or any decrypt/auth failure fails closed.
 */
export class SafeStorageVault implements SecureVault {
  constructor(private readonly safeStorage: SafeStorageLike) {}

  isEncryptionAvailable(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  encryptString(plaintext: string): Uint8Array {
    if (!this.isEncryptionAvailable()) throw new Error('secure vault unavailable');
    const out = this.safeStorage.encryptString(plaintext);
    // Normalize Buffer → Uint8Array (electron returns a Buffer).
    return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayLike<number>);
  }

  decryptString(ciphertext: Uint8Array): string {
    if (!this.isEncryptionAvailable()) throw new Error('secure vault unavailable');
    // electron.safeStorage.decryptString expects a Buffer; it throws on
    // wrong-key / tamper (GCM auth) — we let that propagate as a fail-closed error.
    const buf = typeof Buffer !== 'undefined' ? Buffer.from(ciphertext) : ciphertext;
    return this.safeStorage.decryptString(buf as unknown as Uint8Array);
  }
}

let tmpCounter = 0;

/**
 * Durable, atomic, bounded JSON persistence for the host runtime's public record
 * (which may embed vault-CIPHERTEXT identity/scope blobs — never plaintext).
 */
export class FileHostEnrollmentPersistence implements HostEnrollmentPersistence {
  constructor(
    private readonly filePath: string,
    private readonly maxBytes = 4 * 1024 * 1024,
    private readonly maxControllers = 1000,
    private readonly maxSessions = 10_000,
  ) {}

  load(): HostEnrollmentRecord | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    if (raw.length > this.maxBytes) {
      this.quarantine(raw);
      return null;
    }
    let rec: HostEnrollmentRecord;
    try {
      rec = JSON.parse(raw) as HostEnrollmentRecord;
    } catch {
      this.quarantine(raw);
      return null;
    }
    if (!rec || rec.version !== 1 || typeof rec.hostDeviceId !== 'string' || !Array.isArray(rec.controllers) || !Array.isArray(rec.sessions)) {
      this.quarantine(raw);
      return null;
    }
    if (rec.controllers.length > this.maxControllers || rec.sessions.length > this.maxSessions) {
      this.quarantine(raw);
      return null;
    }
    return rec;
  }

  save(record: HostEnrollmentRecord): void {
    const serialized = JSON.stringify(record);
    if (serialized.length > this.maxBytes) throw new Error('host enrollment record exceeds size bound');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${tmpCounter++}.tmp`;
    try {
      unlinkSync(tmp);
    } catch {
      /* no stale temp */
    }
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, serialized);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* best-effort tightening */
    }
  }

  /** Move a malformed/oversized file aside so a fresh record can be written. */
  private quarantine(raw: string): void {
    try {
      writeFileSync(`${this.filePath}.corrupt`, raw, { mode: 0o600 });
    } catch {
      /* best-effort evidence */
    }
    try {
      unlinkSync(this.filePath);
    } catch {
      /* already gone */
    }
  }
}
