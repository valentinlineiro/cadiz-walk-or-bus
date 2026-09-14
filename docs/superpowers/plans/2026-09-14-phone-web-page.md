# Phone Web Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-file Cloudflare Worker serves phone web page + /api proxy so daily check is one tap.

**Architecture:** `worker.js` serves inline HTML at `/` and proxies Cadiz panel at `/api?stop=&route=`. Copies `parseArrivals`/`decide` from `index.js` verbatim (no bundler, no refactor of CLI).

**Tech Stack:** Cloudflare Workers (vanilla, no framework), vanilla HTML/JS + localStorage, existing `node --test`.

## Global Constraints

- Reuse `parseArrivals`/`decide` logic exactly — no behavior change to CLI.
- No npm deps, no build step, no framework.
- Favorites in `localStorage` only — no auth, no DB.
- Proxy failure → JSON error, client defaults to walk.

---

### Task 1: Worker with HTML UI + /api proxy

**Files:**
- Create: `worker.js`
- Modify: `package.json:6-8` (add dev script)
- Test: `worker.test.js`

**Interfaces:**
- Consumes: `GET http://77.224.241.76/urbanos/mobile/panel.aspx?stop=X&route=Y` (upstream HTML)
- Produces: `GET /` → HTML page; `GET /api?stop=X&route=Y` → `{arrivals: [{line, destination, minutes}]}` or `{error}`

- [ ] **Step 1: Write the failing test**

```js
// worker.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('./worker.js');

test('GET /api returns parsed arrivals with mocked upstream', async () => {
  const html = `<table><tbody><tr><td>1</td><td>CORTADURA</td><td>3min</td></tr></tbody></table>`;
  global.fetch = async () => ({ ok: true, text: async () => html });
  const res = await worker.fetch(new Request('http://x/api?stop=1106&route=110001'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 3 }] });
});

test('GET / serves HTML with favorites UI', async () => {
  const res = await worker.fetch(new Request('http://x/'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /localStorage/);
  assert.match(body, /walkMinutes/);
});

test('GET /api proxies upstream failure as 502', async () => {
  global.fetch = async () => ({ ok: false, status: 500 });
  const res = await worker.fetch(new Request('http://x/api?stop=1&route=2'));
  assert.equal(res.status, 502);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker.test.js`
Expected: FAIL with "Cannot find module './worker.js'"

- [ ] **Step 3: Write minimal implementation**

```js
// worker.js — copy parseArrivals/decide verbatim from index.js (CommonJS for node:test)
function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}
function parseArrivals(html) {
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  const arrivals = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/&nbsp;|<[^>]+>/g, '').trim(),
    );
    if (cells.length < 3) continue;
    const [line, destination, arrival] = cells;
    const relMatch = arrival.match(/^(\d+)\s*min$/i);
    if (!line || !destination || !relMatch) continue;
    arrivals.push({ line, destination, minutes: Number(relMatch[1]) });
  }
  return arrivals;
}
const HTML = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Walk or bus?</title>
<form id="f"><input id="stop" placeholder="stop e.g. 1106"><input id="route" placeholder="route e.g. 110001"><input id="walk" type="number" placeholder="walk min"><button>Check</button></form>
<select id="fav"></select><button id="save">Save favorite</button><pre id="out"></pre>
<script>
const $=id=>document.getElementById(id);
const favs=JSON.parse(localStorage.getItem('favs')||'[]');
function renderFavs(){$('fav').innerHTML=favs.map((f,i)=>'<option value="'+i+'">'+f.name+'</option>').join('');}
renderFavs();
$('fav').onchange=e=>{const f=favs[e.target.value];if(f){$('stop').value=f.stop;$('route').value=f.route;$('walk').value=f.walk;}};
$('save').onclick=()=>{favs.push({name:$('stop').value+'/'+$('route').value,stop:$('stop').value,route:$('route').value,walk:$('walk').value});localStorage.setItem('favs',JSON.stringify(favs));renderFavs();};
$('f').onsubmit=async e=>{e.preventDefault();const s=$('stop').value,r=$('route').value,w=Number($('walk').value);const res=await fetch('/api?stop='+s+'&route='+r);const data=await res.json();if(data.error){$('out').textContent='Panel unreachable -> walk.';return;}const arr=data.arrivals;if(!arr.length){$('out').textContent='Walk: '+w+' min. -> walk.';return;}const soon=arr.reduce((a,b)=>a.minutes<=b.minutes?a:b);$('out').textContent='Bus '+soon.line+' ('+soon.destination+'): '+soon.minutes+' min. Walk: '+w+' min. -> '+(soon.minutes<w?'bus':'walk')+'.';};
</script>`;

async function handleFetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api') {
    const stop = url.searchParams.get('stop'), route = url.searchParams.get('route');
    if (!stop || !route) return Response.json({ error: 'missing stop/route' }, { status: 400 });
    const upstream = await fetch(`http://77.224.241.76/urbanos/mobile/panel.aspx?stop=${stop}&route=${route}`);
    if (!upstream.ok) return Response.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    return Response.json({ arrivals: parseArrivals(await upstream.text()) });
  }
  return new Response(HTML, { headers: { 'content-type': 'text/html' } });
}
// ponytail: CommonJS export for node:test, Worker runtime uses `fetch` global wrapper in wrangler
module.exports = { fetch: handleFetch, parseArrivals, decide };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (existing 5 + new 3 = 8 passing)

- [ ] **Step 5: Commit**

```bash
git add worker.js worker.test.js
git commit -m "feat: worker with phone UI and api proxy"
```

### Task 2: Wrangler config + deploy check

**Files:**
- Create: `wrangler.toml`
- Modify: `package.json:6-8`
- Test: manual `npx wrangler dev` + phone check

**Interfaces:**
- Consumes: `worker.js` `fetch` handler
- Produces: public Worker URL for phone

- [ ] **Step 1: Write minimal wrangler.toml**

```toml
name = "cadiz-walk-or-bus"
main = "worker.js"
compatibility_date = "2026-09-01"
```

- [ ] **Step 2: Add dev script**

```json
"scripts": { "test": "node --test", "dev": "wrangler dev" }
```

- [ ] **Step 3: Verify locally**

Run: `npx wrangler dev`
Expected: `GET /` renders form; `/api?stop=1106&route=110001` returns `{arrivals:[...]}`

- [ ] **Step 4: Commit**

```bash
git add wrangler.toml package.json
git commit -m "chore: wrangler config for phone deploy"
```
