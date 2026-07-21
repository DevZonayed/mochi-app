import React from 'react';
import ReactDOM from 'react-dom/client';
import '@maestro/design-tokens/tokens.css';
import './index.css';
import { App } from './App';
import { startDesktopP2P } from './p2p/peer';
import { startScreenBridge } from './lib/screenBridge';

// Renderer-hosted WebRTC peer (desktop = offerer). Inert without window.maestro
// (the web bundle keeps using the relay); flag-gated on the main side.
startDesktopP2P();

// Phase 3D1 (B2): install window.__maestroScreenFrame + relay native ScreenCaptureKit
// frames to the brain, and drive native start/stop from the brain coordinator. Inert
// without window.maestro (web/phone).
startScreenBridge();

// Tear down the pre-React boot splash (index.html) before mounting so React
// owns a clean #root — otherwise createRoot warns about replacing children.
const rootEl = document.getElementById('root')!;
document.getElementById('boot-splash')?.remove();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
