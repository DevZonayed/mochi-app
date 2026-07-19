import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Node-side vitest for the mobile shadow / enrollment runtime cores. These
 * modules are deliberately platform-free (crypto backend, SecureStore, SQLite,
 * transport all injected), so they run under Node here and Hermes in-app.
 * `expo-sqlite` is aliased to a stub so `shadowClient.ts` resolves in Node; the
 * real store is driven by a node:sqlite adapter in tests.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      'expo-sqlite': resolve(here, '../../tests/native-controller-enrollment-e2e/expo-sqlite-stub.ts'),
    },
  },
});
