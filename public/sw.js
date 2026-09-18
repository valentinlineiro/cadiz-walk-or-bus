// Bump this on every deploy that changes a shell file — the versioned name
// is what makes the activate handler below purge the previous cache instead
// of an install serving stale JS forever.
const CACHE_VERSION = 'v9';
const CACHE_NAME = `andar-o-bus-shell-${CACHE_VERSION}`;

// Explicit allowlist, not a wildcard — only these exact paths are ever
// served cache-first. Live data (/stops, /lines, /api, OSRM, Nominatim,
// FOSSGIS, Leaflet's CDN) must never be answered from this cache.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/web/ui.js',
  '/web/favorites.js',
  '/web/geo.js',
  '/web/map.js',
  '/web/recent.js',
  '/web/scenario.js',
  '/web/sheet-state.js',
  '/web/state.js',
  '/fixtures/gtfs-cadiz.snapshot.json',
  '/web/topology.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !SHELL_URLS.includes(url.pathname)) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request)),
  );
});
