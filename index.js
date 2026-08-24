#!/usr/bin/env node
// Cadiz walk-vs-bus: given a bus stop, a route, and how long it takes to
// walk to the destination, says whether to wait for the bus or walk now.
// Live arrival data source: Cadiz's own transit panel (77.224.241.76),
// the same one BusCadiz uses -- panel.aspx?stop=X&route=Y renders the
// arrival board server-side when given the real internal stop/route IDs
// (not the display line numbers).

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
    // Only relative "Xmin" entries are usable for a right-now decision;
    // absolute clock-time entries (e.g. "18:31") are a later trip, not
    // relevant to "wait or walk right now" -- skipped, not misread.
    const relMatch = arrival.match(/^(\d+)\s*min$/i);
    if (!line || !destination || !relMatch) continue;
    arrivals.push({ line, destination, minutes: Number(relMatch[1]) });
  }
  return arrivals;
}

async function main(stop, route, walkMinutes) {
  const url = `http://77.224.241.76/urbanos/mobile/panel.aspx?stop=${stop}&route=${route}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch arrival panel: HTTP ${res.status}`);
    process.exit(1);
  }
  const html = await res.text();
  const arrivals = parseArrivals(html);
  // Waiting for the bus costs (time until it arrives) -- boarding is
  // effectively instant compared to the bus's own travel time, which
  // this MVP does not model yet (deferred: bus travel time to destination).
  const { decision, soonest } = decide(arrivals, walkMinutes);

  if (!soonest) {
    console.log(`No upcoming bus arrivals found for stop ${stop} / route ${route} right now.`);
  } else {
    console.log(`Bus ${soonest.line} (${soonest.destination}): arrives in ${soonest.minutes} min.`);
  }
  console.log(`Walk: ${walkMinutes} min.`);
  console.log(`-> ${decision}.`);
}

module.exports = { parseArrivals, decide };

if (require.main === module) {
  const [, , stop, route, walkMinutesArg] = process.argv;

  if (!stop || !route || !walkMinutesArg) {
    console.error('Usage: node index.js <stop> <route> <walkMinutes>');
    console.error('Example: node index.js 1106 110001 19');
    process.exit(1);
  }

  const walkMinutes = Number(walkMinutesArg);
  if (!Number.isFinite(walkMinutes) || walkMinutes < 0) {
    console.error(`Invalid walkMinutes: ${walkMinutesArg}`);
    process.exit(1);
  }

  main(stop, route, walkMinutes).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
