// Kept out of worker.js: a Worker entrypoint module may only export handlers, not constants.
export const MAP_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>¿Andar o bus? — Cádiz</title>
<link rel="stylesheet" href="/vendor/leaflet/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; }
  #search-box { position: fixed; top: 12px; left: 12px; right: 12px; z-index: 1000; }
  #search { display: flex; gap: 8px; }
  #search input { flex: 1; font-size: 16px; padding: 12px 14px; border: 1px solid #ccc; border-radius: 12px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.15); outline: none; }
  #search input:focus { border-color: #16a34a; }
  #search button { padding: 0 16px; font-size: 15px; font-weight: bold; border: none; background: #16a34a; color: #fff; border-radius: 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  #dropdown { margin-top: 6px; background: #fff; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.2); overflow: hidden; max-height: 280px; overflow-y: auto; }
  .dropdown-header { padding: 8px 14px 4px; font-size: 11px; font-weight: 700; color: #888; letter-spacing: .08em; text-transform: uppercase; }
  .dropdown-item { padding: 10px 14px; display: flex; align-items: center; gap: 10px; cursor: pointer; border-top: 1px solid #f3f4f6; }
  .dropdown-item:first-of-type { border-top: none; }
  .dropdown-item:hover, .dropdown-item:active { background: #f3f4f6; }
  .dropdown-item .icon { font-size: 16px; flex-shrink: 0; }
  .dropdown-item .text { flex: 1; min-width: 0; }
  .dropdown-item .main { font-size: 14px; font-weight: 600; color: #111; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dropdown-item .sub { font-size: 12px; color: #6b7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hidden { display: none !important; }
  #sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1000; background: #fff; border-radius: 16px 16px 0 0; padding: 16px; box-shadow: 0 -2px 12px rgba(0,0,0,.2); font-size: 16px; }
  #verdict { font-size: 28px; font-weight: bold; }
  .duel { display: flex; gap: 10px; }
  .side { flex: 1; border: 2px solid #e5e7eb; border-radius: 12px; padding: 12px; text-align: center; opacity: .65; }
  .side .mins { font-weight: 800; font-size: 22px; }
  .side .lbl { font-size: 12px; color: #666; letter-spacing: .06em; }
  .side .check { display: none; font-weight: 900; font-size: 20px; }
  .side.winner { opacity: 1; }
  .side.winner.walk { border-color: #16a34a; }
  .side.winner.bus { border-color: #d97706; }
  .side.winner .check { display: block; }
  .side.winner.bus .check { color: #d97706; }
  .side.winner.walk .check { color: #16a34a; }
  #verdict { font-size: 28px; font-weight: 900; }
  #verdict.bus { color: #d97706; }
  #verdict.walk { color: #16a34a; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #ccc; border-top-color: #16a34a; border-radius: 50%; }
</style>
</head>
<body>
<div id="map"></div>
<div id="search-box">
  <form id="search">
    <input id="q" placeholder="¿A dónde vas?" autocomplete="off" />
    <button type="submit">Ir</button>
  </form>
  <div id="dropdown" class="hidden"></div>
</div>
<div id="sheet"><div id="status">Localizando…</div><div id="verdict"></div><div id="detail"></div></div>
<script src="/vendor/leaflet/leaflet.js"></script>
<script type="module">
import { initUI } from './web/ui.js';
initUI();
</script>
</body>
</html>`;

// Same policy as public/_headers (static assets get theirs from that file; this page is served
// by the Worker itself). architecture-gate fails if the two drift.
export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'sha256-qw9Gtbho6SGxg+t7p2uoPXcR4gzWdAdJ4wSf5r2ev+w=' 'sha256-QLq51P9W4Te60ChkY3EEM0hais/w5klnhC2VD3tnPDc='; style-src 'self' 'unsafe-inline'; img-src 'self' https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'geolocation=(self)',
};
