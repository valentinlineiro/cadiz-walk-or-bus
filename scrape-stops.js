const BASE = 'http://77.224.241.76/urbanos/mobile';

function hiddenInputs(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

export async function searchStops(fetchImpl, query) {
  const formHtml = await (await fetchImpl(`${BASE}/default.aspx`)).text();
  const body = new URLSearchParams({
    ...hiddenInputs(formHtml),
    'ctl00$ContentPlaceHolderContenido$txtBusStopName': query,
    'ctl00$ContentPlaceHolderContenido$txtBusStopNumber': '',
    'ctl00$ContentPlaceHolderContenido$txtLineNumber': '',
    'ctl00$ContentPlaceHolderContenido$btnSearch': 'Búsqueda',
  });
  const resHtml = await (
    await fetchImpl(`${BASE}/default.aspx`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  ).text();
  const action = resHtml.match(/<form[^>]*action="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const marker = resHtml.indexOf('RepeaterBusStops');
  const seg = resHtml.slice(resHtml.lastIndexOf('<table', marker));
  const rows = [];
  for (const r of seg.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 2 || !cells[0] || !cells[1]) continue;
    rows.push({ number: cells[0], name: cells[1], index: rows.length, detailAction: action, detailFields: hiddenInputs(resHtml) });
  }
  return rows;
}

export async function resolveIds(fetchImpl, row) {
  const btns = Object.keys(row.detailFields).filter((k) => k.endsWith('$btnTimes'));
  const btn = btns[row.index];
  if (!btn) throw new Error(`no button for row ${row.index} (${row.name})`);
  const fields = { ...row.detailFields };
  for (const k of btns) if (k !== btn) delete fields[k];
  const body = new URLSearchParams({ ...fields, [btn]: '' });
  const action = row.detailAction.startsWith('http') ? row.detailAction : `${BASE}/${row.detailAction.replace(/^\.\//, '')}`;
  const resHtml = (await (await fetchImpl(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).text()).replaceAll('&amp;', '&');
  const m = resHtml.match(/panel\.aspx\?[^"]*stop=(\d+)/);
  if (!m) throw new Error(`no panel stop ID for ${row.name} (${row.number})`);
  return { stop: m[1] };
}

export async function geocode(fetchImpl, name) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name + ', Cádiz, Spain')}&format=json&limit=1`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'cadiz-walk-or-bus (one-time scraper)' } });
  const [hit] = await r.json();
  await new Promise((r2) => setTimeout(r2, 1100));
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

export async function crawl(fetchImpl, queries) {
  const seen = new Map();
  for (const q of queries) {
    for (const row of await searchStops(fetchImpl, q)) {
      if (seen.has(row.number)) continue;
      const ids = await resolveIds(fetchImpl, row);
      const coords = await geocode(fetchImpl, row.name);
      if (!coords) { console.error(`no coords, dropping ${row.name} (${row.number})`); continue; }
      seen.set(row.number, { name: row.name, number: row.number, ...ids, ...coords });
    }
  }
  return [...seen.values()];
}
