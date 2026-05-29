import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

// --- PWA service worker registration ------------------------------------
// Registering sw.js (which has a fetch handler) is what makes Chrome offer the
// "Install" option again. sw.js is network-first, so it never serves stale code
// while online — it only falls back to cache when the device is offline.
// updateViaCache:'none' means the browser always fetches a fresh sw.js to check
// for updates, so new versions are picked up promptly without a vercel.json.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update())
      .catch((err) => console.error('SW registration failed:', err));

    // When a *new* worker takes over an already-controlled page (i.e. a genuine
    // update), reload once so the freshest code runs. Skipped on first install
    // so the very first visit doesn't flash a reload. Guarded against loops.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      window.location.reload();
    });
  });
}
