import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './navigation';

/* Standalone navigation ref so non-React modules (api.ts) can route — e.g. bounce
   to Onboarding when the relay rejects this device. Kept in its own module so it
   carries no runtime dependency on navigation.tsx (which imports api.ts), avoiding
   an import cycle; the RootStackParamList import is type-only and erased at build. */
export const navRef = createNavigationContainerRef<RootStackParamList>();

/** Drop to the Onboarding / enter-code flow. Best-effort (no-op until nav is ready). */
export function gotoRepair(): void {
  try {
    if (navRef.isReady()) navRef.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
  } catch { /* navigation not ready */ }
}
