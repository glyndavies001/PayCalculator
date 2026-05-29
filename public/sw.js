// Vaulted service worker — NETWORK FIRST.
//
// Why this exists:
//  1. Chrome only offers "Install" when a service worker with a *fetch* handler
//     is controlling the page. This file provides that, so the install banner
//     (App.js) reappears.
//  2. It is network-first: while online it always fetches the latest code from
//     the network, so it can NEVER serve stale JS. The cache is only ever used
//     as a fallback when the device is offline.
//
// It deliberately ignores API calls and anything cross-origin (Supabase,
// Anthropic) so those always hit the network untouched.

const CACHE = "vaulted-runtime";
const SHELL = ["/", "/index.html", "/manifest.json", "/favicon.ico", "/icon-192.png", "/icon-512.png"];

// Install: take over immediately and pre-cache the app shell for offline use.
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})
  );
});

// Activate: delete every other cache (this wipes the old aggressive cache that
// caused the stale-JS bug) and take control of open pages.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first for same-origin GETs; cache only as an offline fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Let non-GET, cross-origin (Supabase/Anthropic), and API calls pass straight
  // through to the network — never cache or intercept them.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Stash a fresh copy for offline use (successful same-origin responses only).
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // Offline: serve the cached copy, or fall back to the app shell for navigations.
        caches.match(req).then((cached) => cached || caches.match("/index.html"))
      )
  );
});

// Let the page tell a waiting worker to activate immediately.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
