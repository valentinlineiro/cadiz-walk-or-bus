import { haversineMeters } from './topology.js';

const WALK_METERS_PER_MINUTE = 80;
const BUS_METERS_PER_MINUTE = 250;

export const DEFAULT_PLANNING_POLICY = {
  maxCandidates: 3,
  maxAlternatives: 2,
  similarityMaxDeltaMinutes: 5,
};

export function createWalkCandidate({ walkMinutes, origin, destination }) {
  const mins = Math.max(0, Math.round(walkMinutes ?? 0));
  return {
    identity: 'walk:direct',
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

export function createBusCandidates({ arrivals, stop, walkToStopMinutes, resolveAlight }) {
  if (!Array.isArray(arrivals) || arrivals.length === 0 || !stop || typeof resolveAlight !== 'function') {
    return [];
  }

  const walkToStop = Math.max(0, Math.round(walkToStopMinutes ?? 0));
  const candidates = [];

  for (const arr of arrivals) {
    // Temporal reachability: bus must not arrive before user can reach the stop
    if (arr.minutes == null || arr.minutes < walkToStop) continue;

    const alight = resolveAlight(arr);
    if (!alight || !alight.stop) continue;

    const rideMins = alight.rideMeters != null ? Math.round(alight.rideMeters / BUS_METERS_PER_MINUTE) : 0;
    const lastMileMins = alight.distanceMeters != null ? Math.round(alight.distanceMeters / WALK_METERS_PER_MINUTE) : 0;
    const totalEstimated = walkToStop + arr.minutes + rideMins + lastMileMins;

    const stopId = String(stop.stop ?? stop.number ?? '');
    const alightId = String(alight.stop.stop ?? alight.stop.number ?? '');
    const lineStr = String(arr.line ?? '');

    candidates.push({
      identity: `bus:${lineStr}:${stopId}:${alightId}`,
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
        alightStop: alight.stop,
        path: alight.path ?? [],
        alightDistanceMeters: alight.distanceMeters,
      },
    });
  }

  return candidates;
}

export function isStructurallyDiverse(
  candidate,
  hero,
  thresholds = { accessWalkMinutes: 3, alightDistanceMeters: 250 },
) {
  if (!candidate || !hero) return false;
  if (candidate.identity === hero.identity) return false;

  // 1. Modal diversity
  if (candidate.mode !== hero.mode) {
    return true;
  }

  // 2. Line diversity (for bus)
  if (candidate.mode === 'bus' && hero.mode === 'bus') {
    const candLine = candidate.metadata?.line ?? (candidate.identity.startsWith('bus:') ? candidate.identity.split(':')[1] : null);
    const heroLine = hero.metadata?.line ?? (hero.identity.startsWith('bus:') ? hero.identity.split(':')[1] : null);

    if (candLine && heroLine && candLine !== heroLine) {
      return true;
    }

    // 3. Access diversity (same line)
    const accessWalkThreshold = thresholds?.accessWalkMinutes ?? 3;
    const candWalk = candidate.exactJourney?.walkToStopRoute?.minutes ?? candidate.exactJourney?.walkToStopMinutes ?? candidate.estimate?.walkToStopMinutes ?? 0;
    const heroWalk = hero.exactJourney?.walkToStopRoute?.minutes ?? hero.exactJourney?.walkToStopMinutes ?? hero.estimate?.walkToStopMinutes ?? 0;
    if (Math.abs(candWalk - heroWalk) >= accessWalkThreshold) {
      return true;
    }

    const alightDistThreshold = thresholds?.alightDistanceMeters ?? 250;
    const candAlightMeters = candidate.metadata?.alightDistanceMeters ?? 0;
    const heroAlightMeters = hero.metadata?.alightDistanceMeters ?? 0;

    if (Math.abs(candAlightMeters - heroAlightMeters) >= alightDistThreshold) {
      return true;
    }

    return false;
  }

  return false;
}

export function filterDiverseAlternatives(candidates, hero, policy = DEFAULT_PLANNING_POLICY) {
  if (!hero || !Array.isArray(candidates)) return [];
  const maxDelta = policy.similarityMaxDeltaMinutes ?? 5;
  const maxAlts = policy.maxAlternatives ?? 2;
  const maxCandidates = policy.maxCandidates ?? 3;
  const allowedAlternatives = Math.min(maxAlts, Math.max(0, maxCandidates - 1));
  if (allowedAlternatives <= 0) return [];

  const admitted = [];
  for (const cand of candidates) {
    if (admitted.length >= allowedAlternatives) break;
    if (!cand || cand.identity === hero.identity) continue;
    if (cand.estimatedMinutes - hero.estimatedMinutes > maxDelta) continue;

    // Must be structurally diverse from the Hero
    if (!isStructurallyDiverse(cand, hero)) continue;

    // Must also be structurally diverse from any already admitted alternative
    if (admitted.some((alt) => !isStructurallyDiverse(cand, alt))) continue;

    admitted.push(cand);
  }

  return admitted;
}

export function selectCandidates(candidates, policy = DEFAULT_PLANNING_POLICY) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { primary: null, alternatives: [] };
  }

  const maxCandidates = policy.maxCandidates ?? 3;
  if (maxCandidates <= 0) {
    return { primary: null, alternatives: [] };
  }

  // Deduplicate by structural identity: keep the candidate with lowest estimatedMinutes
  const byIdentity = new Map();
  for (const c of candidates) {
    if (!c || typeof c.estimatedMinutes !== 'number') continue;
    const existing = byIdentity.get(c.identity);
    if (!existing || c.estimatedMinutes < existing.estimatedMinutes) {
      byIdentity.set(c.identity, c);
    }
  }

  const unique = Array.from(byIdentity.values());
  if (unique.length === 0) {
    return { primary: null, alternatives: [] };
  }

  // Sort strictly by estimatedMinutes ascending
  unique.sort((a, b) => a.estimatedMinutes - b.estimatedMinutes);

  const primary = unique[0];
  const alternatives = filterDiverseAlternatives(unique.slice(1), primary, policy);

  return { primary, alternatives };
}

export function cheapWalkToStop(me, stop, walkToStopCache) {
  if (!me || !stop) return 0;
  const stopId = String(stop.stop ?? stop.number ?? '');
  if (walkToStopCache && walkToStopCache.has(stopId)) {
    const cached = walkToStopCache.get(stopId);
    if (cached && typeof cached.minutes === 'number') {
      return cached.minutes;
    }
  }
  const distMeters = haversineMeters(me.lat, me.lon, stop.lat, stop.lon);
  return Math.max(0, Math.round(distMeters / WALK_METERS_PER_MINUTE));
}

export function formatAlternativeDiff(candidate, primary) {
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
