import stops from './stops.json' with { type: 'json' };
import lines from './lines.json' with { type: 'json' };

// Reverse-DNS name of 77.224.241.76 (the panel's real IP) -- Workers' fetch()
// refuses plain-HTTP requests to a bare IP with error 1003, so a hostname is
// required even though there's no real domain for this internal panel.
const PANEL_HOST = 'static-76-241-224-77.ipcom.comunitel.net';

export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function parseArrivals(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  if (!/<table[^>]*>/i.test(html)) return null;

  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  const arrivals = [];
  let foundCandidateRow = false;

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/&nbsp;|<[^>]+>/g, '').trim(),
    );
    if (cells.length < 3) continue;
    foundCandidateRow = true;
    const [line, destination, arrival] = cells;
    if (!line || !destination) continue;

    let minutes;
    const relMatch = arrival.match(/^(\d+)\s*min$/i);
    if (relMatch) {
      minutes = Number(relMatch[1]);
    } else if (/^inminente$/i.test(arrival.trim())) {
      minutes = 0;
    } else {
      continue;
    }

    arrivals.push({ line, destination, minutes });
  }

  // If the table contains <td> data rows but none conformed to the 3-column transit structure,
  // the page structure is unrecognizable or an error table.
  const allTdRows = rows.filter((r) => /<td[^>]*>/i.test(r));
  if (allTdRows.length > 0 && !foundCandidateRow) {
    return null;
  }

  return arrivals;
}

const MAP_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>¿Andar o bus? — Cádiz</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
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
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script type="module">
import { initUI } from './web/ui.js';
initUI();
</script>
</body>
</html>`;

async function handleFetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/stops') return Response.json(stops);
  if (url.pathname === '/lines') return Response.json(lines);
  if (url.pathname === '/api') {
    const stop = url.searchParams.get('stop');
    const route = url.searchParams.get('route');
    if (!stop || !/^[a-zA-Z0-9_-]{1,16}$/.test(stop)) {
      return Response.json({ error: 'missing or invalid stop' }, { status: 400 });
    }
    if (route !== null && route !== '' && !/^[a-zA-Z0-9_-]{1,16}$/.test(route)) {
      return Response.json({ error: 'invalid route' }, { status: 400 });
    }
    // Workers' fetch() rejects plain-HTTP requests to a bare IP literal with its
    // own error 1003 ("Direct IP access not allowed") before the request ever
    // leaves Cloudflare's network. PANEL_HOST is the panel server's real reverse-DNS
    // name (resolves to the same 77.224.241.76) -- using it sidesteps that entirely.
    const encodedStop = encodeURIComponent(stop);
    const encodedRoute = route ? encodeURIComponent(route) : '';
    const panel = encodedRoute
      ? `http://${PANEL_HOST}/urbanos/mobile/panel.aspx?stop=${encodedStop}&route=${encodedRoute}`
      : `http://${PANEL_HOST}/urbanos/mobile/panel.aspx?stop=${encodedStop}`;
    let upstream;
    try {
      upstream = await globalThis.fetch(panel, { signal: AbortSignal.timeout(4000) });
    } catch {
      return Response.json({ error: 'upstream unreachable' }, { status: 502 });
    }
    if (!upstream.ok) return Response.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    const arrivals = parseArrivals(await upstream.text());
    if (arrivals === null) {
      return Response.json({ error: 'malformed upstream response' }, { status: 502 });
    }
    return Response.json({ arrivals });
  }
  if (url.pathname === '/' || url.pathname === '/map' || url.pathname === '/map.html') {
    return new Response(MAP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new Response('not found', { status: 404 });
}

export default { fetch: handleFetch };
