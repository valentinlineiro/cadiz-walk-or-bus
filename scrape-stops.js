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
  const seg = resHtml.slice(resHtml.indexOf('RepeaterBusStops'));
  const rows = [];
  for (const r of seg.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 2 || !cells[0] || !cells[1]) continue;
    rows.push({ number: cells[0], name: cells[1], detailAction: action, detailFields: hiddenInputs(resHtml) });
  }
  return rows;
}
