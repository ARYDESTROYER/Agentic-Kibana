// Side-effect import: statically register the EUI icons the app uses BEFORE any
// component renders. Must stay first — without it EUI lazy-`import()`s each glyph
// as a runtime chunk that the nginx-served bundle cannot resolve, so every icon
// renders as a blank gray square. See src/lib/icons.ts.
import './lib/icons';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
