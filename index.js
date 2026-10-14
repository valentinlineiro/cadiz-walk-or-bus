#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
// Cadiz walk-vs-bus: given a bus stop, a route, and how long it takes to
// walk to the destination, says whether to wait for the bus or walk now.
// Live arrival data source: Cadiz's own transit panel (77.224.241.76),
// the same one BusCadiz uses -- panel.aspx?stop=X&route=Y renders the
// arrival board server-side when given the real internal stop/route IDs
// (not the display line numbers).

export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

const TRANSIT_ARRIVAL_PATTERN = /^(\d+\s*min|inminente|\d{1,2}:\d{2}|sin servicio|en cochera|fuera de servicio|>\s*\d+\s*min)$/i;

export function parseArrivals(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  if (!/<table[^>]*>/i.test(html)) return null;

  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const arrivals = [];
  let foundValidTransitRow = false;

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/&nbsp;|<[^>]+>/g, '').trim(),
    );
    if (cells.length < 3) continue;
    const [line, destination, arrival] = cells;
    if (!line || !destination) continue;

    // Validate that the row conforms to genuine transit panel arrival semantics
    const isTransitPattern = TRANSIT_ARRIVAL_PATTERN.test(arrival.trim()) || arrival.trim() === '';
    if (!isTransitPattern) continue;

    foundValidTransitRow = true;

    let minutes;
    const relMatch = arrival.match(/^(\d+)\s*min$/i);
    if (relMatch) {
      minutes = Number(relMatch[1]);
    } else if (/^inminente$/i.test(arrival.trim())) {
      // In the municipal panel, "Inminente" signifies the vehicle is arriving at the platform (< 1 min wait)
      minutes = 0;
    } else {
      // Absolute clock times (e.g. "15:30"), out-of-service ("Sin servicio"), bounds ("> 45 min"), or empty cells are ignored
      continue;
    }

    arrivals.push({ line, destination, minutes });
  }

  // If the table contains <td> data rows but not a single row conformed to the transit arrival structure,
  // the page structure is unrecognizable or an error table.
  const allTdRows = rows.filter((r) => /<td[^>]*>/i.test(r));
  if (allTdRows.length > 0 && !foundValidTransitRow) {
    return null;
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
  if (arrivals === null) {
    console.error(`Failed to parse arrival panel: malformed upstream response for stop ${stop} / route ${route}.`);
    process.exit(1);
  }
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
