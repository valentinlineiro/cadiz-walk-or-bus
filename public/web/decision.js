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

export function verdict(walkTotal, walkToStop, arrivals, resolveAlight) {
  if (walkTotal == null) {
    return { kind: 'walk', walkMinutes: null, walkToStop: walkToStop ?? null, bus: null };
  }
  const candidates = filterCandidates(arrivals, resolveAlight);
  if (candidates.length === 0) {
    return { kind: 'walk', walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus: null };
  }
  const soonest = candidates.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
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
