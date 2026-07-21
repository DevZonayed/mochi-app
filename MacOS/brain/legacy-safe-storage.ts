/* Legacy Electron / Chromium macOS "v10" Safe Storage decryption + one-time
   migration support.

   The old Electron desktop app encrypted provider secrets with Chromium's
   OSCrypt, storing a `v10`-prefixed blob whose master password lives in the
   macOS login Keychain under the generic-password service "<AppName> Safe
   Storage" (for the old app: "@maestro/desktop Safe Storage"). The WebKit
   sidecar inherited that store but its shim decoded the ciphertext as UTF-8,
   yielding U+FFFD mojibake. This module decrypts such blobs CORRECTLY so a
   provider row can be migrated to the new MS1 envelope exactly once.

   macOS OSCrypt v10 scheme:
     key = PBKDF2-HMAC-SHA1(masterPassword, salt="saltysalt", iters=1003, len=16)
     AES-128-CBC, IV = 16 bytes of 0x20 (space), PKCS7 padding
     ciphertext = "v10" || AES-CBC(plaintext)
   Everything here is pure + fail-closed; the password fetch is the only
   side-effecting call and it captures/suppresses output so nothing leaks. */
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const V10 = Buffer.from('v10', 'utf8'); // 0x76 0x31 0x30

/** True when `blob` starts with the Chromium v10 marker and has ciphertext. */
export function isElectronV10(blob: Buffer): boolean {
  return blob.length > V10.length && blob.subarray(0, V10.length).equals(V10);
}

/** Decrypt a macOS v10 OSCrypt blob given the Safe Storage MASTER PASSWORD (the
    Keychain generic-password value — NOT the API key). Fails CLOSED: throws on a
    non-v10 marker, a non-block-aligned ciphertext, or bad PKCS7 padding (which
    is what a wrong password or a tampered blob produces). */
export function decryptElectronV10(blob: Buffer, masterPassword: string): Buffer {
  if (!isElectronV10(blob)) throw new Error('not a v10 blob');
  const ct = blob.subarray(V10.length);
  if (ct.length === 0 || ct.length % 16 !== 0) throw new Error('v10 ciphertext length invalid');
  const key = pbkdf2Sync(masterPassword, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ct), decipher.final()]); // final() throws on bad padding
}

/** The channel-scoped legacy Keychain SERVICE name.
    - production (default): EXACTLY "@maestro/desktop Safe Storage" — the old
      Electron app's OSCrypt service (proven present on the operator's Mac).
    - preview / development: their OWN (nonexistent) service, so a non-production
      channel NEVER reads the production master password…
    - …unless MAESTRO_LEGACY_SAFE_STORAGE_SERVICE explicitly overrides it (a
      test-only escape hatch used by the isolated Preview migration proof). */
export function legacyServiceForChannel(
  channel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.MAESTRO_LEGACY_SAFE_STORAGE_SERVICE;
  if (override && override.trim()) return override.trim();
  switch (channel) {
    case 'preview': return '@maestro/desktop-preview Safe Storage';
    case 'development': return '@maestro/desktop-development Safe Storage';
    default: return '@maestro/desktop Safe Storage';
  }
}

/** Read the legacy Safe Storage master password from the macOS login Keychain
    via `security find-generic-password -s <service> -w`. The service name (not a
    secret) is the only argv value; stdout (the password) is captured and NEVER
    logged. Returns undefined if absent/unreadable (never throws).

    IMPORTANT: this is a SYNCHRONOUS call on the sidecar's single event loop, and
    reading the password can raise a macOS Keychain ACL prompt (the legacy item
    is bound to the old Electron app's signature). A hard `timeout` bounds how
    long an unanswered prompt can stall every other RPC — on timeout the child is
    killed and we fall back to "reconnect" rather than freezing the app forever. */
export function fetchLegacySafeStoragePassword(service: string, timeoutMs = 8000): string | undefined {
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    const pw = out.replace(/\r?\n$/, '');
    return pw.length ? pw : undefined;
  } catch {
    return undefined;
  }
}
