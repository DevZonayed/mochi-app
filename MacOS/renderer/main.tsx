import React from 'react';
import ReactDOM from 'react-dom/client';
import '@maestro/design-tokens/tokens.css';
import './index.css';
import { App } from './App';
import { startDesktopP2P } from './p2p/peer';

// Renderer-hosted WebRTC peer (desktop = offerer). Inert without window.maestro
// (the web bundle keeps using the relay); flag-gated on the main side.
startDesktopP2P();

// Tear down the pre-React boot splash (index.html) before mounting so React
// owns a clean #root — otherwise createRoot warns about replacing children.
const rootEl = document.getElementById('root')!;
document.getElementById('boot-splash')?.remove();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
