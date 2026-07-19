/**
 * shadowEnrollment — Phase 3A2a mobile enrollment product barrel. This is the
 * single import surface 3A2b uses to reach the enrollment runtime and its
 * concrete Expo-backed production adapters. Importing it pulls the full
 * production module graph (noble crypto + expo-crypto CSPRNG, expo-secure-store,
 * expo-sqlite meta store, realtime subpaths) into the app bundle — with NO
 * network or auto-start on import (the runtime is lazily constructed).
 */
export * from './shadowEnrollmentClient';
export * from './shadowControllerService';
export * from './shadowEnrollmentRuntimeFactory';
export * from './shadowSecureStore';
export * from './shadowEnrollmentMetaStore';
export * from './shadowCryptoNoble';
