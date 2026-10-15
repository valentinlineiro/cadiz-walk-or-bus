// GTFS_FEED_VERSION is synchronized with /fixtures/gtfs-cadiz.snapshot.json by `npm run ingest:gtfs`.
const GTFS_FEED_VERSION = 'nap-2026-09-18';
// SHELL_HASH fingerprints every file in SHELL_URLS plus this file. Never edit it by hand:
// `npm run shell:hash` rewrites it, and the architecture gate fails while it is stale. A new
// hash is what makes installed clients drop the previous cache-first shell.
const SHELL_HASH = '8b2dd94b09a5';
const CACHE_VERSION = `${SHELL_HASH}-${GTFS_FEED_VERSION}`;
const CACHE_NAME = `andar-o-bus-shell-${CACHE_VERSION}`;

// Explicit allowlist, not a wildcard — only these exact paths are ever
// served cache-first. Live data (/stops, /lines, /api, OSRM, Nominatim,
// FOSSGIS) must never be answered from this cache.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/web/ui.js',
  '/web/favorites.js',
  '/web/geo.js',
  '/web/map.js',
  '/web/recent.js',
  '/web/scenario.js',
  '/web/sheet-state.js',
  '/web/state.js',
  '/web/domain/constants.js',
  '/web/domain/diversity.js',
  '/web/domain/identity.js',
  '/web/domain/last-mile.js',
  '/web/domain/planner.js',
  '/web/domain/topology.js',
  '/web/application/composition.js',
  '/web/application/index.js',
  '/web/application/ports/GeocodingPort.js',
  '/web/application/ports/TransitDataPort.js',
  '/web/application/use-cases/FindBestJourneysUseCase.js',
  '/web/application/use-cases/GetEligibleArrivalsUseCase.js',
  '/web/application/use-cases/GetQuickVerdictUseCase.js',
  '/web/application/use-cases/RecordUserChoiceUseCase.js',
  '/web/application/use-cases/SearchDestinationsUseCase.js',
  '/web/infrastructure/index.js',
  '/web/infrastructure/geocoding/NominatimGeocodingAdapter.js',
  '/web/infrastructure/persistence/LocalStorageJourneyLogAdapter.js',
  '/web/infrastructure/routing/OsrmRoutingAdapter.js',
  '/web/infrastructure/transit/GtfsTransitAdapter.js',
  '/web/infrastructure/transit/MunicipalTransitAdapter.js',
  '/web/infrastructure/transit/ResilientTransitAdapter.js',
  '/fixtures/gtfs-cadiz.snapshot.json',
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
