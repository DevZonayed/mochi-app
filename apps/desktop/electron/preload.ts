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
  // Inline image bytes for the chat, keyed by Asset id. Desktop-only; never relayed.
  assetImage: (assetId: string): Promise<MaestroCallResult> => ipcRenderer.invoke('maestro:assetImage', assetId),
  // Live browser preview frame (PNG data URL, no Asset created). Desktop-only —
  // raw bytes never cross the relay; the phone gets only slimmed browser state.
  browserView: (projectId: string | null): Promise<MaestroCallResult> => ipcRenderer.invoke('maestro:browserView', projectId),
  // Read-only filesystem access for the in-app file viewer. Confined to the
  // project's own folder on the main side; intentionally NOT in the relay
  // dispatch, so the phone/web remotes can never read local files.
  readFile: (projectId: string, p: string): Promise<MaestroCallResult> => ipcRenderer.invoke('maestro:readFile', projectId, p),
  listDir: (projectId: string, p?: string): Promise<MaestroCallResult> => ipcRenderer.invoke('maestro:listDir', projectId, p ?? ''),
  // Run / Terminal — run a shell command in the project folder, stream output.
  runCommand: (projectId: string, command: string): Promise<MaestroCallResult> => ipcRenderer.invoke('maestro:runCommand', projectId, command),
  killCommand: (runId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('maestro:killCommand', runId),
  onCmdOutput: (cb: (p: { runId: string; stream: string; chunk: string; code?: number }) => void): (() => void) => {
    const l = (_e: unknown, payload: { runId: string; stream: string; chunk: string; code?: number }) => cb(payload);
    ipcRenderer.on('maestro:cmd-output', l);
    return () => ipcRenderer.removeListener('maestro:cmd-output', l);
  },
});
