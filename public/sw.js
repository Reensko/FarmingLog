// === CoC Farming Tracker Service Worker ===
// Strategy: network-first with cache fallback
// - When online: always fetch fresh (so updates show up immediately)
// - When offline: serve from cache
//
// Bump CACHE_VERSION when you want to force-update all clients
// (e.g. after pushing a new version of the app).

const CACHE_VERSION = "v1";
const CACHE_NAME = `coc-tracker-${CACHE_VERSION}`;

// App shell – minimal files always cached on install
// Vite's hashed bundles get cached dynamically via the fetch handler
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
];

// === INSTALL: precache app shell ===
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
  // Activate new SW immediately, don't wait for tab reload
  self.skipWaiting();
});

// === ACTIVATE: clean up old caches ===
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  // Take control of all open tabs without requiring reload
  self.clients.claim();
});

// === FETCH: network-first, fall back to cache ===
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET requests (POST/PUT/etc go straight to network)
  if (request.method !== "GET") return;

  // Skip cross-origin requests (CDN, Google Fonts, Tesseract from unpkg, etc.)
  // These should always go to network; if offline, they fail gracefully on the page
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for offline use
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed → try cache
        return caches.match(request).then((cached) => {
          if (cached) return cached;
          // For navigation requests (page loads), fall back to index.html
          // This makes SPAs work even on routes that aren't pre-cached
          if (request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return new Response("Offline", { status: 503, statusText: "Offline" });
        });
      })
  );
});
