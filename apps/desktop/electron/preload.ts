import { contextBridge } from 'electron';

// Minimal, safe bridge. The renderer talks to Maestro Core over this surface
// (RPC wiring lands when the apps connect to packages/core).
contextBridge.exposeInMainWorld('maestro', {
  platform: process.platform,
});
