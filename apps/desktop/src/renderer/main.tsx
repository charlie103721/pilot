import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * Renderer entry point. Deliberately minimal: if the root element is missing
 * the page says so, because a blank window with a silent console is the worst
 * possible failure mode for a panel that has no other surface.
 */

const container = document.getElementById('root');

if (container === null) {
  document.body.textContent = 'Pilot could not start: the panel root element is missing.';
} else {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
