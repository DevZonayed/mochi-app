/**
 * shadowSecureStore — Phase 3A2a PRODUCTION `expo-secure-store` adapter for the
 * mobile enrollment runtime's `SecureStoreAdapter` seam. Device private seeds and
 * the unwrapped account scope key live ONLY here — never AsyncStorage, never the
 * shadow SQLite DB.
 *
 *  - Accessibility: `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` — the item is readable
 *    only after first unlock and never syncs off the device (no iCloud Keychain).
 *  - Logical keys (which include `account:<id>` scope ids) are mapped to a
 *    SecureStore-legal physical key via base64url so the `:`/other characters the
 *    keychain rejects can't appear; the mapping is deterministic + collision-free.
 *  - Values are size-capped; native errors fail closed (rethrow) — there is NO
 *    plaintext / AsyncStorage fallback path anywhere in this module.
 */
import * as SecureStore from 'expo-secure-store';

const MAX_VALUE_BYTES = 2048; // Expo SecureStore's recommended per-item ceiling.

/** base64url(utf8(logicalKey)) — SecureStore keys allow only [A-Za-z0-9._-]. */
function physicalKey(logicalKey: string): string {
  const bytes = new TextEncoder().encode(logicalKey);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64'));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function options(): SecureStore.SecureStoreOptions {
  return { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
}

export class ExpoSecureStoreAdapter {
  async getItemAsync(key: string): Promise<string | null> {
    // Fail closed: a native/keychain error must NOT be swallowed into a null that
    // could be mistaken for "no value" and trigger a re-enroll with fresh keys.
    return await SecureStore.getItemAsync(physicalKey(key), options());
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    const size = new TextEncoder().encode(value).length;
    if (size > MAX_VALUE_BYTES) throw new Error(`secure value exceeds ${MAX_VALUE_BYTES} bytes`);
    await SecureStore.setItemAsync(physicalKey(key), value, options());
  }

  async deleteItemAsync(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(physicalKey(key), options());
  }
}

export { physicalKey as __physicalKeyForTest };
