import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/* AES-256-GCM encryption for provider API keys at rest.

   The key derives from MAESTRO_SECRET if set; otherwise a random secret is
   generated once and persisted next to the DB (on the data volume) so keys
   survive restarts. Keys are never logged or returned to clients. */

function loadSecret(): Buffer {
  const env = process.env.MAESTRO_SECRET;
  if (env && env.length >= 16) return scryptSync(env, 'maestro.providers.v1', 32);

  const dbPath = process.env.DB_PATH || ':memory:';
  const dir = dbPath === ':memory:' ? '/tmp' : dirname(dbPath);
  const file = join(dir, '.maestro_secret');
  try {
    if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    mkdirSync(dir, { recursive: true });
    const s = randomBytes(32);
    writeFileSync(file, s.toString('hex'), { mode: 0o600 });
    return s;
  } catch {
    // Last-resort ephemeral key (won't survive restart, but won't crash).
    return scryptSync('maestro-fallback-secret', 'maestro.providers.v1', 32);
  }
}

const KEY = loadSecret();

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

export function decrypt(blob: string): string {
  const [ivh, tagh, ench] = blob.split(':');
  if (!ivh || !tagh || !ench) throw new Error('malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivh, 'hex'));
  decipher.setAuthTag(Buffer.from(tagh, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ench, 'hex')), decipher.final()]).toString('utf8');
}
