import { haversineMeters } from './topology.js';
import {
  WALK_METERS_PER_MINUTE,
  BUS_METERS_PER_MINUTE,
  DEFAULT_PLANNING_POLICY,
  type PlanningPolicy,
  type PlanningPolicyOverrides,
} from './constants.js';
import {
  createWalkIdentity,
  createBusIdentity,
  serializeIdentity,
} from './identity.js';
import { isStructurallyDiverse, filterDiverseAlternatives, type StructurallyDiverseItem } from './diversity.js';
import type { Coordinates, JourneyCandidate, Stop } from './models.js';

export { DEFAULT_PLANNING_POLICY, isStructurallyDiverse, filterDiverseAlternatives };

export interface CreateWalkCandidateOptions {
  walkMinutes?: number | null;
  origin?: Coordinates;
  destination?: Coordinates & { label?: string };
}

export function createWalkCandidate({ walkMinutes, origin, destination }: CreateWalkCandidateOptions): JourneyCandidate {
  const mins = Math.max(0, Math.round(walkMinutes ?? 0));
  return {
    identity: createWalkIdentity(),
    mode: 'walk',
    estimatedMinutes: mins,
    dataQuality: 'live',
    estimate: {
      walkToStopMinutes: 0,
      waitMinutes: 0,
      rideMinutes: 0,
      lastMileMinutes: mins,
    },
    metadata: {
      origin,
      destination,
    },
  };
}

export interface AlightResolutionResult {
  stop?: Stop;
  alightStop?: Stop;
  distanceMeters?: number;
  alightDistanceMeters?: number;
  rideMeters?: number;
  rideMinutes?: number;
  path?: Stop[];
}

export interface CreateBusCandidatesOptions {
  arrivals?: any[];
  stop?: Stop;
  destCoords?: Coordinates;
  walkToStopMinutes?: number;
  resolveAlight?: (arrival: any) => any;
}

export function createBusCandidates({
  arrivals,
  stop,
  walkToStopMinutes,
  resolveAlight,
}: CreateBusCandidatesOptions): JourneyCandidate[] {
  if (!Array.isArray(arrivals) || arrivals.length === 0 || !stop || typeof resolveAlight !== 'function') {
    return [];
  }

  const walkToStop = Math.max(0, Math.round(walkToStopMinutes ?? 0));
  const candidates: JourneyCandidate[] = [];

  for (const arr of arrivals) {
    // Temporal reachability: bus must not arrive before user can reach the stop
    if (arr.minutes == null || arr.minutes < walkToStop) continue;

    const alight = resolveAlight(arr);
    const resolvedStop: Stop | undefined = alight?.stop ?? alight?.alightStop;
    if (!alight || !resolvedStop) continue;

    const alightDist: number | undefined = alight.distanceMeters ?? alight.alightDistanceMeters;
    const rideMins = alight.rideMinutes != null
      ? alight.rideMinutes
      : alight.rideMeters != null
        ? Math.round(alight.rideMeters / BUS_METERS_PER_MINUTE)
        : 0;
    const lastMileMins = alightDist != null ? Math.round(alightDist / WALK_METERS_PER_MINUTE) : 0;
    const totalEstimated = walkToStop + arr.minutes + rideMins + lastMileMins;

    const stopId = String(stop.stop ?? (stop as any).number ?? '');
    const alightId = String(resolvedStop.stop ?? (resolvedStop as any).number ?? '');
    const lineStr = String(arr.line ?? '');

    candidates.push({
      identity: createBusIdentity(lineStr, stopId, alightId),
      mode: 'bus',
      estimatedMinutes: totalEstimated,
      dataQuality: arr.minutes != null ? 'live' : 'estimated',
      estimate: {
        walkToStopMinutes: walkToStop,
        waitMinutes: arr.minutes,
        rideMinutes: rideMins,
        lastMileMinutes: lastMileMins,
      },
      metadata: {
        line: lineStr,
        destination: arr.destination,
        boardingStop: stop,
        alightStop: resolvedStop,
        path: alight.path ?? [],
        alightDistanceMeters: alightDist,
      },
    });
  }

  return candidates;
}

export interface CandidateSelectionResult<T = JourneyCandidate> {
  primary: T | null;
  alternatives: T[];
}

export function selectCandidates<T extends StructurallyDiverseItem>(
  candidates: T[],
  policy: PlanningPolicy | PlanningPolicyOverrides = DEFAULT_PLANNING_POLICY,
): CandidateSelectionResult<T> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { primary: null, alternatives: [] };
  }

  const maxCandidates = (policy as PlanningPolicy).maxCandidates ?? 3;
  if (maxCandidates <= 0) {
    return { primary: null, alternatives: [] };
  }

  // Deduplicate by structural identity: keep the candidate with lowest estimatedMinutes
  // serializeIdentity() provides a stable string key for the Map — identity objects are not primitives.
  const byIdentity = new Map<string, T>();
  for (const c of candidates) {
    if (!c || typeof c.estimatedMinutes !== 'number' || !c.identity) continue;
    const key = serializeIdentity(c.identity);
    const existing = byIdentity.get(key);
    if (!existing || (c.estimatedMinutes < (existing.estimatedMinutes ?? Infinity))) {
      byIdentity.set(key, c);
    }
  }

  const unique = Array.from(byIdentity.values());
  if (unique.length === 0) {
    return { primary: null, alternatives: [] };
  }

  // Sort strictly by estimatedMinutes ascending
  unique.sort((a, b) => (a.estimatedMinutes ?? 0) - (b.estimatedMinutes ?? 0));

  const primary = unique[0];
  const alternatives = filterDiverseAlternatives(unique.slice(1), primary, policy);

  return { primary, alternatives };
}

export function cheapWalkToStop(
  me: Coordinates | null | undefined,
  stop: Stop | null | undefined,
  walkToStopCache?: Map<string, { minutes: number }>,
): number {
  if (!me || !stop) return 0;
  const stopId = String(stop.stop ?? (stop as any).number ?? '');
  if (walkToStopCache && walkToStopCache.has(stopId)) {
    const cached = walkToStopCache.get(stopId);
    if (cached && typeof cached.minutes === 'number') {
      return cached.minutes;
    }
  }
  const distMeters = haversineMeters(me.lat, me.lon, stop.lat, stop.lon);
  return Math.max(0, Math.round(distMeters / WALK_METERS_PER_MINUTE));
}

export function formatAlternativeDiff(candidate: any, primary: any): string {
  if (!candidate) return '';
  if (candidate.mode === 'walk') {
    return 'Ruta directa a pie';
  }

  const cMeta = candidate.metadata ?? {};
  const pMeta = primary?.metadata ?? {};

  // 1. Line difference
  if (cMeta.line && (!pMeta.line || String(cMeta.line) !== String(pMeta.line))) {
    const lineStr = String(cMeta.line).startsWith('L') ? cMeta.line : `Línea ${cMeta.line}`;
    const wait = candidate.estimate?.waitMinutes != null ? ` · espera ${candidate.estimate.waitMinutes}′` : '';
    return `${lineStr}${wait}`;
  }

  // 2. Boarding stop difference
  const cBoard = String(cMeta.boardingStop?.stop ?? cMeta.boardingStop?.number ?? '');
  const pBoard = String(pMeta.boardingStop?.stop ?? pMeta.boardingStop?.number ?? '');
  if (cBoard && cBoard !== pBoard) {
    const boardName = cMeta.boardingStop?.name ? `Desde ${cMeta.boardingStop.name}` : 'Desde otra parada';
    const walk = candidate.estimate?.walkToStopMinutes != null ? ` (caminar ${candidate.estimate.walkToStopMinutes}′)` : '';
    return `${boardName}${walk}`;
  }

  // 3. Alighting stop difference
  const cAlight = String(cMeta.alightStop?.stop ?? cMeta.alightStop?.number ?? '');
  const pAlight = String(pMeta.alightStop?.stop ?? pMeta.alightStop?.number ?? '');
  if (cAlight && cAlight !== pAlight) {
    return cMeta.alightStop?.name ? `Baja en ${cMeta.alightStop.name}` : 'Baja en otra parada';
  }

  // Default fallback
  if (candidate.estimate?.waitMinutes != null) {
    return `Espera ${candidate.estimate.waitMinutes}′`;
  }
  return 'Opción alternativa';
}
