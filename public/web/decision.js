export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function filterCandidates(arrivals, resolveAlight) {
  if (!Array.isArray(arrivals) || arrivals.length === 0) return [];
  if (typeof resolveAlight !== 'function') {
    return arrivals.map((a) => ({ ...a, alight: a.alight ?? null }));
  }
  const eligible = [];
  for (const arr of arrivals) {
    const alight = resolveAlight(arr);
    if (alight && alight.stop) {
      eligible.push({ ...arr, alight });
    }
  }
  return eligible;
}

// ponytail: constant urban walking pace (4.8 km/h) to rank the last-mile
// walk from alight stop to destination, not a bus-speed guess like the
// removed driveMinutes() — swap for a real OSRM last-mile time if the
// ranking needs to get sharper than "prefer the bus that lands you closer".
const WALK_METERS_PER_MINUTE = 80;

function rankScore(candidate) {
  const lastMile = candidate.alight?.distanceMeters != null ? candidate.alight.distanceMeters / WALK_METERS_PER_MINUTE : 0;
  return candidate.minutes + lastMile;
}

export function verdict(walkTotal, walkToStop, arrivals, resolveAlight) {
  if (walkTotal == null) {
    return { kind: 'walk', walkMinutes: null, walkToStop: walkToStop ?? null, bus: null };
  }
  const candidates = filterCandidates(arrivals, resolveAlight);
  if (candidates.length === 0) {
    return { kind: 'walk', walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus: null };
  }
  const soonest = candidates.reduce((a, b) => (rankScore(a) <= rankScore(b) ? a : b));
  const bus = {
    minutes: soonest.minutes,
    total: (walkToStop ?? 0) + soonest.minutes,
    line: soonest.line,
    destination: soonest.destination,
    alight: soonest.alight ?? null,
  };
  const kind = bus.total < walkTotal ? 'bus' : 'walk';
  return { kind, walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus };
}
