import stops from './stops.json' with { type: 'json' };

export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function parseArrivals(html) {
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
<form id="f"><input id="stop" placeholder="stop e.g. 1106"><input id="route" placeholder="route e.g. 110001"><input id="walkMinutes" type="number" placeholder="walk min"><button>Check</button></form>
<select id="fav"></select><button id="save">Save favorite</button><pre id="out"></pre>
<script>
const $=id=>document.getElementById(id);
const favs=JSON.parse(localStorage.getItem('favs')||'[]');
function renderFavs(){$('fav').innerHTML=favs.map((f,i)=>'<option value="'+i+'">'+f.name+'</option>').join('');}
renderFavs();
$('fav').onchange=e=>{const f=favs[e.target.value];if(f){$('stop').value=f.stop;$('route').value=f.route;$('walkMinutes').value=f.walk;}};
$('save').onclick=()=>{favs.push({name:$('stop').value+'/'+$('route').value,stop:$('stop').value,route:$('route').value,walk:$('walkMinutes').value});localStorage.setItem('favs',JSON.stringify(favs));renderFavs();};
$('f').onsubmit=async e=>{e.preventDefault();const s=$('stop').value,r=$('route').value,w=Number($('walkMinutes').value);const res=await fetch('/api?stop='+s+'&route='+r);const data=await res.json();if(data.error){$('out').textContent='Panel unreachable -> walk.';return;}const arr=data.arrivals;if(!arr.length){$('out').textContent='Walk: '+w+' min. -> walk.';return;}const soon=arr.reduce((a,b)=>a.minutes<=b.minutes?a:b);$('out').textContent='Bus '+soon.line+' ('+soon.destination+'): '+soon.minutes+' min. Walk: '+w+' min. -> '+(soon.minutes<w?'bus':'walk')+'.';};
</script>`;

async function handleFetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/stops') return Response.json(stops);
  if (url.pathname === '/api') {
    const stop = url.searchParams.get('stop');
    const route = url.searchParams.get('route');
    if (!stop) return Response.json({ error: 'missing stop/route' }, { status: 400 });
    const panel = route
      ? `http://77.224.241.76/urbanos/mobile/panel.aspx?stop=${stop}&route=${route}`
      : `http://77.224.241.76/urbanos/mobile/panel.aspx?stop=${stop}`;
    let upstream;
    try {
      upstream = await globalThis.fetch(panel);
    } catch {
      return Response.json({ error: 'upstream unreachable' }, { status: 502 });
    }
    if (!upstream.ok) return Response.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    return Response.json({ arrivals: parseArrivals(await upstream.text()) });
  }
  return new Response(HTML, { headers: { 'content-type': 'text/html' } });
}

export default { fetch: handleFetch };
