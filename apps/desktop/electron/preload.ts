import { contextBridge, ipcRenderer } from 'electron';

export interface MaestroCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  status?: number;
}

// Bridge to the local Maestro core (main process). ALL app data + execution is
// local to this Mac; the renderer talks to it here instead of any remote API.
contextBridge.exposeInMainWorld('maestro', {
  platform: process.platform,
  localEngine: true,
  call: (method: string, params?: Record<string, unknown>): Promise<MaestroCallResult> =>
    ipcRenderer.invoke('maestro:call', method, params ?? {}),
  onEvent: (cb: (e: { name: string; data: unknown }) => void): (() => void) => {
    const listener = (_e: unknown, payload: { name: string; data: unknown }) => cb(payload);
    ipcRenderer.on('maestro:event', listener);
    return () => ipcRenderer.removeListener('maestro:event', listener);
  },
  // Desktop-only native affordances (never available to web/mobile remotes).
  pickFolder: (): Promise<MaestroCallResult> => ipcRenderer.invoke('maestro:pickFolder'),
  revealPath: (p: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('maestro:revealPath', p),
  importAsset: (projectId: string | null): Promise<MaestroCallResult> => ipcRenderer.invoke('maestro:importAsset', projectId),
});
