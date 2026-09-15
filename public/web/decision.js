export function decide(arrivals, walkMinutes) {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function verdict(walkMinutes, arrivals) {
  if (walkMinutes == null || arrivals.length === 0) return { kind: 'walk', walkMinutes, bus: null };
  const { decision, soonest } = decide(arrivals, walkMinutes);
  if (decision !== 'bus') return { kind: 'walk', walkMinutes, bus: null };
  return { kind: 'bus', walkMinutes, bus: { minutes: soonest.minutes, line: soonest.line, destination: soonest.destination } };
}
