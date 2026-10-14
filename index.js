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

const LIVE_ARRIVAL_PATTERN = /^(\d+\s*min|inminente)$/i;
const OUT_OF_SERVICE_PATTERN = /^(sin servicio|en cochera|fuera de servicio)$/i;

export function parseArrivals(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  if (!/<table[^>]*>/i.test(html)) return null;

  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const arrivals = [];
  let hasAuthoritativeStatus = false;
  let hasLiveArrival = false;

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
      m[1].replace(/&nbsp;|<[^>]+>/g, '').trim(),
    );
    if (cells.length < 3) continue;
    const [line, destination, arrival] = cells;
    if (!line || !destination) continue;

    const trimmedArrival = arrival.trim();

    // Check if this row is an explicit out-of-service status (confirmed by operator)
    if (OUT_OF_SERVICE_PATTERN.test(trimmedArrival)) {
      hasAuthoritativeStatus = true;
      continue;
    }

    // Check if this row has live relative minutes or imminent arrival
    if (LIVE_ARRIVAL_PATTERN.test(trimmedArrival)) {
      hasLiveArrival = true;
      let minutes = 0;
      const relMatch = trimmedArrival.match(/^(\d+)\s*min$/i);
      if (relMatch) {
        minutes = Number(relMatch[1]);
      }
      arrivals.push({ line, destination, minutes });
      continue;
    }

    // Clock times (e.g. "15:30") or bounds (e.g. "> 45 min") indicate static timetables
    // or entries beyond live telemetry horizon. They are skipped here.
  }

  // If the table contains <td> data rows but we found neither actionable live arrivals
  // nor an explicit out-of-service status (e.g. only static clock times, bounds, error messages,
  // or empty cells), live realtime tracking is unavailable -> return null to allow GTFS scheduled fallback.
  const allTdRows = rows.filter((r) => /<td[^>]*>/i.test(r));
  if (allTdRows.length > 0 && !hasLiveArrival && !hasAuthoritativeStatus) {
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
