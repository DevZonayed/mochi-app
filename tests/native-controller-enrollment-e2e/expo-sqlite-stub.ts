/**
 * Deterministic stub for `expo-sqlite` used ONLY by the cross-tier E2E vitest
 * config. The real `ExpoSQLiteShadowStore` is DB-agnostic and is driven here by a
 * genuine Node 24 `node:sqlite` adapter (the established expo mock seam), so the
 * native module is never touched. The stub exists only so `shadowClient.ts`'s
 * top-level `import * as SQLite from 'expo-sqlite'` resolves in Node.
 */
export function openDatabaseSync(): never {
  throw new Error('expo-sqlite is stubbed in the E2E; use the node:sqlite adapter');
}
export function openDatabaseAsync(): never {
  throw new Error('expo-sqlite is stubbed in the E2E; use the node:sqlite adapter');
}
export default { openDatabaseSync, openDatabaseAsync };
