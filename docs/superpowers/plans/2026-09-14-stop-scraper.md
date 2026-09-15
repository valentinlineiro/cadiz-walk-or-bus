# Stop Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crawl the Cádiz panel site once into `stops.json` and serve it at `GET /stops` for map pins.

**Architecture:** `scrape-stops.js` (Node stdlib, manual run) drives the site's own search flow: `POST default.aspx` (name query) → intermediate `search.aspx` form → parse `RepeaterBusStops` rows → per-row `btnTimes` postback → panel `stop=`/`route=` IDs → Nominatim geocode (cached, 1 req/s) → `stops.json`. Worker serves the file verbatim at `GET /stops`.

**Tech Stack:** Node 24 stdlib only (`fetch`, regex), existing `node --test`, Nominatim (one-time, scrape time only).

## Global Constraints

- No npm deps, no build step, no framework.
- `parseArrivals`/`decide`/CLI behavior unchanged.
- Never geocode at request time — coords resolved once at scrape time, cached in `stops.json`.
- Partial rows never written — `stops.json` written only on full success; stops without coords dropped with stderr warning.

---

### Task 1: Search client (query → stop rows)

**Files:**
- Create: `scrape-stops.js` (exports `searchStops(fetchImpl, query)`)
- Test: `scrape-stops.test.js`

**Interfaces:**
- Consumes: `GET http://77.224.241.76/urbanos/mobile/default.aspx` (form with `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`)
- Produces: `searchStops(fetch, 'CORTADURA')` → `[{ number: '1114', name: 'CORTADURA', detailFields: {...}, detailAction: '...' }, ...]` (detail fields = all intermediate-form inputs for Task 2)

- [ ] **Step 1: Write the failing test**

```js
// scrape-stops.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchStops } = require('./scrape-stops.js');

const FORM_HTML = `<form action="./default.aspx"><input type="hidden" name="__VIEWSTATE" value="VS1" />
<input type="hidden" name="__VIEWSTATEGENERATOR" value="VG1" />
<input type="hidden" name="__EVENTVALIDATION" value="EV1" /></form>`;
const RESULT_HTML = `<form action="./search.aspx?t1=CORTADURA&amp;t2=&amp;t3=">
<table id="ctl00_ContentPlaceHolderContenido_RepeaterBusStops">
<tr><td>1114</td><td>CORTADURA</td><td></td></tr>
<tr><td>1901</td><td>CORTADURA</td><td></td></tr>
</table>
<input name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl01$btnTimes" value="" />
<input name="__VIEWSTATE" value="VS2" /></form>`;

test('searchStops posts the query and parses [number, name] rows', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([url, opts?.method || 'GET', opts?.body || '']);
    return { ok: true, text: async () => (calls.length === 1 ? FORM_HTML : RESULT_HTML) };
  };
  const rows = await searchStops(fetchImpl, 'CORTADURA');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].number, '1114');
  assert.equal(rows[0].name, 'CORTADURA');
  assert.match(calls[1][2], /txtBusStopName=CORTADURA/);
  assert.match(calls[1][2], /btnSearch/);
  assert.ok(rows[0].detailAction.includes('search.aspx?t1=CORTADURA'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scrape-stops.test.js`
Expected: FAIL with "Cannot find module './scrape-stops.js'"

- [ ] **Step 3: Write minimal implementation**

```js
const BASE = 'http://77.224.241.76/urbanos/mobile';

function hiddenInputs(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

async function searchStops(fetchImpl, query) {
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

module.exports = { searchStops };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scrape-stops.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scrape-stops.js scrape-stops.test.js
git commit -m "feat: stop search client for scraper"
```

### Task 2: ID resolution + geocode + stops.json writer

**Files:**
- Modify: `scrape-stops.js` (add `resolveIds`, `geocode`, `crawl`)
- Modify: `scrape-stops.test.js` (append tests below)
- Produces: `stops.json` (git-committed data, created by live run in Task 3 — NOT in this task)

**Interfaces:**
- Consumes: Task 1 row `{ detailAction, detailFields }` (row button name `ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctlNN$btnTimes` found in `detailFields` keys)
- Produces: `resolveIds(fetch, row)` → `{ stop: '1106', route: '110001' }`; `crawl(fetch, queries)` → full `[{name, number, stop, route, lat, lon}]` array (no file write — caller writes)

- [ ] **Step 1: Write the failing tests**

```js
test('resolveIds follows the row postback to panel stop/route IDs', async () => {
  const row = {
    detailAction: './search.aspx?t1=CORTADURA&t2=&t3=',
    detailFields: { __VIEWSTATE: 'VS2', 'ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl01$btnTimes': '' },
  };
  const fetchImpl = async () => ({ ok: true, text: async () => '<a href="panel.aspx?stop=1106&route=110001">Horarios</a>' });
  assert.deepEqual(await resolveIds(fetchImpl, row), { stop: '1106', route: '110001' });
});

test('crawl dedupes stops across queries and drops rows without coords', async () => {
  const fetchImpl = async (url, opts) => {
    const body = opts?.body || '';
    if (opts?.method === 'POST' && body.includes('btnSearch')) {
      return { ok: true, text: async () => `<form action="./search.aspx?t1=X&t2=&t3="><table><tr><td>1114</td><td>CORTADURA</td><td></td></tr></table><input name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl01$btnTimes" value=""/><input name="__VIEWSTATE" value="V"/></form>` };
    }
    if (url.includes('nominatim')) {
      return { ok: true, json: async () => [{ lat: '36.5001', lon: '-6.2721' }] };
    }
    return { ok: true, text: async () => 'panel.aspx?stop=1106&route=110001' };
  };
  const rows = await crawl(fetchImpl, ['CORTADURA', 'CORTADURA']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { name: 'CORTADURA', number: '1114', stop: '1106', route: '110001', lat: 36.5001, lon: -6.2721 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scrape-stops.test.js`
Expected: FAIL with "resolveIds is not defined"

- [ ] **Step 3: Write minimal implementation** (append to `scrape-stops.js`)

```js
async function resolveIds(fetchImpl, row) {
  const btn = Object.keys(row.detailFields).find((k) => k.endsWith('$btnTimes'));
  const body = new URLSearchParams({ ...row.detailFields, __EVENTTARGET: btn });
  const action = row.detailAction.startsWith('http') ? row.detailAction : `${BASE}/${row.detailAction.replace(/^\.\//, '')}`;
  const resHtml = await (await fetchImpl(action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).text();
  const m = resHtml.match(/panel\.aspx\?stop=(\d+)&route=(\d+)/);
  if (!m) throw new Error(`no panel IDs for ${row.name} (${row.number})`);
  return { stop: m[1], route: m[2] };
}

async function geocode(fetchImpl, name) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name + ', Cádiz, Spain')}&format=json&limit=1`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'cadiz-walk-or-bus (one-time scraper)' } });
  const [hit] = await r.json();
  await new Promise((r2) => setTimeout(r2, 1100));
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon) } : null;
}

async function crawl(fetchImpl, queries) {
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

module.exports = { searchStops, resolveIds, geocode, crawl };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites green)

- [ ] **Step 5: Commit**

```bash
git add scrape-stops.js scrape-stops.test.js
git commit -m "feat: scraper ID resolution and geocoded crawl"
```

### Task 3: Live crawl + GET /stops endpoint

**Files:**
- Modify: `scrape-stops.js` (append CLI main: queries = two-letter combos `aa`..`zz` + `00`..`99` over `abcdefghijklmnñopqrstuvwxyz0123456789`; runs `crawl`, writes `stops.json` only on full success)
- Create: `stops.json` (live output, committed)
- Modify: `worker.js` (add `GET /stops` serving the file content: `import stops from './stops.json' with { type: 'json' }` — if import attributes fail under wrangler, fallback: inline file read at build; implementer picks what passes `wrangler deploy --dry-run`)
- Modify: `worker.test.js` (add: `GET /stops` → 200 JSON array whose first item has `name/number/stop/route/lat/lon`)

**Interfaces:**
- Consumes: Task 2 `crawl`; live site + live Nominatim (1 req/s throttle already in `geocode`)
- Produces: `GET /stops` → `[{name, number, stop, route, lat, lon}]`

- [ ] **Step 1: Write the failing worker test**

```js
test('GET /stops returns the stop directory', async () => {
  const res = await worker.fetch(new Request('http://x/stops'));
  assert.equal(res.status, 200);
  const stops = await res.json();
  assert.ok(stops.length > 0);
  assert.deepEqual(Object.keys(stops[0]).sort(), ['lat', 'lon', 'name', 'number', 'route', 'stop']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker.test.js`
Expected: FAIL (404 or missing route)

- [ ] **Step 3: Wire /stops + CLI main, run live crawl**

CLI main (append to `scrape-stops.js`):

```js
if (require.main === module) {
  const chars = 'abcdefghijklmnñopqrstuvwxyz0123456789';
  const queries = [];
  for (const a of chars) for (const b of chars) queries.push(a + b);
  crawl(fetch, queries).then((rows) => {
    require('node:fs').writeFileSync('stops.json', JSON.stringify(rows, null, 2));
    console.error(`wrote stops.json with ${rows.length} stops`);
  }).catch((err) => { console.error(err.message); process.exit(1); });
}
```

Run: `node scrape-stops.js` (slow: ~1300 queries × 2 requests + geocodes; interrupt-safe — file written only at end)
Expected: `wrote stops.json with N stops` (N > 0); spot-check `grep -c '"stop"' stops.json` and that CORTADURA rows exist

- [ ] **Step 4: Run full suite + dry-run**

Run: `npm test` (PASS) and `npx -y wrangler deploy --dry-run` (PASS, nothing deployed)

- [ ] **Step 5: Commit** (include row count)

```bash
git add scrape-stops.js worker.js worker.test.js stops.json
git commit -m "feat: live stop directory (N stops) served at GET /stops"
```
