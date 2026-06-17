/* Real device biometrics (Face ID / Touch ID / fingerprint) for gating approvals.
   Backed by expo-local-authentication, which is bundled in Expo Go. */

import * as LocalAuthentication from 'expo-local-authentication';
import { getFlag, BIOMETRIC_GATE } from './storage';

/** Whether the operator turned on "require biometrics to approve". */
export function biometricGateEnabled(): boolean {
  return getFlag(BIOMETRIC_GATE);
}

/** True only if this device has biometric hardware AND an enrolled identity. */
export async function biometricAvailable(): Promise<boolean> {
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

/** Prompt for biometrics. Resolves true on success. Fails OPEN when the device
    has no biometrics enrolled, so a passcode-only device is never locked out. */
export async function confirmBiometric(prompt: string): Promise<boolean> {
  try {
    if (!(await biometricAvailable())) return true;
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      fallbackLabel: 'Use passcode',
    });
    return res.success;
  } catch {
    return true;
  }
}
