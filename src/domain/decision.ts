import type { Arrival, AlightResolution, BusDecision, Verdict } from './models.js';

export function decide(
  arrivals: Arrival[],
  walkMinutes: number
): { decision: 'bus' | 'walk'; soonest: Arrival | null } {
  if (arrivals.length === 0) return { decision: 'walk', soonest: null };
  const soonest = arrivals.reduce((a, b) => (a.minutes <= b.minutes ? a : b));
  const decision = soonest.minutes < walkMinutes ? 'bus' : 'walk';
  return { decision, soonest };
}

export function filterCandidates(
  arrivals: Arrival[],
  resolveAlight?: ((candidate: Arrival) => AlightResolution | null) | null
): Arrival[] {
  if (!Array.isArray(arrivals) || arrivals.length === 0) return [];
  if (typeof resolveAlight !== 'function') {
    return arrivals.map((a) => ({ ...a, alight: a.alight ?? null }));
  }
  const eligible: Arrival[] = [];
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

// ponytail: constant urban bus pace (~15 km/h, incl. stops/traffic) to
// estimate ride time from rideMeters — swap for the busRoute() driving-time
// estimate (already fetched for the map line) if this needs to get sharper.
const BUS_METERS_PER_MINUTE = 250;

function rideMinutes(candidate: Arrival): number {
  return candidate.alight?.rideMeters != null ? candidate.alight.rideMeters / BUS_METERS_PER_MINUTE : 0;
}

function rankScore(candidate: Arrival): number {
  const lastMile =
    candidate.alight?.distanceMeters != null ? candidate.alight.distanceMeters / WALK_METERS_PER_MINUTE : 0;
  return candidate.minutes + rideMinutes(candidate) + lastMile;
}

// A bus arriving before you can physically reach the stop isn't catchable —
// showing it as "arrives in 1'" when the walk there takes 5' is misleading,
// not useful. Arriving exactly as it does (walkToStop === minutes) still
// counts as making it.
function reachable(candidate: Arrival, walkToStop: number | null | undefined): boolean {
  return walkToStop == null || candidate.minutes >= walkToStop;
}

export function verdict(
  walkTotal: number | null | undefined,
  walkToStop: number | null | undefined,
  arrivals: Arrival[],
  resolveAlight?: ((candidate: Arrival) => AlightResolution | null) | null
): Verdict {
  if (walkTotal == null) {
    return { kind: 'walk', walkMinutes: null, walkToStop: walkToStop ?? null, bus: null };
  }
  const candidates = filterCandidates(arrivals, resolveAlight).filter((c) => reachable(c, walkToStop));
  if (candidates.length === 0) {
    return { kind: 'walk', walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus: null };
  }
  const soonest = candidates.reduce((a, b) => (rankScore(a) <= rankScore(b) ? a : b));
  const ride = Math.round(rideMinutes(soonest));
  const bus: BusDecision = {
    minutes: soonest.minutes,
    rideMinutes: ride,
    total: (walkToStop ?? 0) + soonest.minutes + ride,
    line: soonest.line,
    destination: soonest.destination,
    alight: soonest.alight ?? null,
  };
  const kind = bus.total < walkTotal ? 'bus' : 'walk';
  return { kind, walkMinutes: walkTotal, walkToStop: walkToStop ?? null, bus };
}
