/* Lightweight persisted flags for the mobile app.
   localStorage exists on Expo web (the deployed target, m.nexalance.cloud); on
   native it's absent, so reads fall back to false (shows onboarding). */

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function getFlag(key: string): boolean {
  return ls()?.getItem(key) === '1';
}

export function setFlag(key: string, val: boolean): void {
  try {
    ls()?.setItem(key, val ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export const ONBOARDED = 'maestro.mobile.onboarded';
export const PAIR_TOKEN = 'maestro.mobile.token';

export function getStr(key: string): string {
  try { return ls()?.getItem(key) ?? ''; } catch { return ''; }
}
export function setStr(key: string, val: string): void {
  try { ls()?.setItem(key, val); } catch { /* storage unavailable */ }
}
