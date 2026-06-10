import React from 'react';
import ReactDOM from 'react-dom/client';
import '@maestro/design-tokens/tokens.css';
import './index.css';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
