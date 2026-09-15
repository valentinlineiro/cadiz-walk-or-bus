export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function verdict(walkTotal, walkToStop, rideEst, arrivals) {
  if (walkTotal == null || arrivals.length === 0) {
    return { kind: 'walk', walkMinutes: walkTotal, walkToStop: walkToStop ?? null, rideEst: rideEst ?? null, bus: null };
  }
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const bus = {
    minutes: soonest.minutes,
    total: (walkToStop ?? 0) + soonest.minutes + (rideEst ?? 0),
    line: soonest.line,
    destination: soonest.destination,
    ride: rideEst ?? null,
  };
  const kind = bus.total < walkTotal ? 'bus' : 'walk';
  return { kind, walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus };
}
