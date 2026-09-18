import { haversineMeters } from './topology.js';
import { WALK_METERS_PER_MINUTE, BUS_METERS_PER_MINUTE, DEFAULT_PLANNING_POLICY, } from './constants.js';
import { createWalkIdentity, createBusIdentity, serializeIdentity, } from './identity.js';
import { isStructurallyDiverse, filterDiverseAlternatives } from './diversity.js';
export { DEFAULT_PLANNING_POLICY, isStructurallyDiverse, filterDiverseAlternatives };
export function createWalkCandidate({ walkMinutes, origin, destination }) {
    const mins = Math.max(1, Math.round(walkMinutes ?? 0));
    return {
        identity: createWalkIdentity(),
        mode: 'walk',
        estimatedMinutes: mins,
        dataQuality: walkMinutes != null ? 'live' : 'estimated',
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
export function createBusCandidates({ arrivals, stop, walkToStopMinutes, resolveAlight, }) {
    if (!Array.isArray(arrivals) || arrivals.length === 0 || !stop || typeof resolveAlight !== 'function') {
        return [];
    }
    const walkToStop = Math.max(0, Math.round(walkToStopMinutes ?? 0));
    const candidates = [];
    for (const arr of arrivals) {
        // Temporal reachability: bus must not arrive before user can reach the stop
        if (arr.minutes == null || arr.minutes < walkToStop)
            continue;
        const alight = resolveAlight(arr);
        const resolvedStop = alight?.stop ?? alight?.alightStop;
        if (!alight || !resolvedStop)
            continue;
        const alightDist = alight.distanceMeters ?? alight.alightDistanceMeters;
        const rideMins = alight.rideMinutes != null
            ? alight.rideMinutes
            : alight.rideMeters != null
                ? Math.round(alight.rideMeters / BUS_METERS_PER_MINUTE)
                : 0;
        const lastMileMins = alightDist != null ? Math.round(alightDist / WALK_METERS_PER_MINUTE) : 0;
        const totalEstimated = walkToStop + arr.minutes + rideMins + lastMileMins;
        const stopId = String(stop.stop ?? stop.number ?? '');
        const alightId = String(resolvedStop.stop ?? resolvedStop.number ?? '');
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
                source: arr.source,
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
export function resolveEligibleArrivals(arrivals, resolveAlight) {
    if (!Array.isArray(arrivals) || arrivals.length === 0)
        return [];
    if (typeof resolveAlight !== 'function') {
        return arrivals.map((arrival) => ({ ...arrival, alight: arrival.alight ?? null }));
    }
    return arrivals.flatMap((arrival) => {
        const alight = resolveAlight(arrival);
        return alight?.stop ? [{ ...arrival, alight }] : [];
    });
}
export function chooseQuickBus(arrivals, walkToStopMinutes, resolveAlight) {
    const walkToStop = walkToStopMinutes ?? 0;
    let best = null;
    let bestRank = Infinity;
    for (const arrival of arrivals ?? []) {
        if (arrival.minutes == null || (walkToStopMinutes != null && arrival.minutes < walkToStop))
            continue;
        const alight = typeof resolveAlight === 'function' ? resolveAlight(arrival) : (arrival.alight ?? null);
        if (typeof resolveAlight === 'function' && !alight?.stop)
            continue;
        const rideMinutes = alight?.rideMeters != null
            ? alight.rideMeters / BUS_METERS_PER_MINUTE
            : 0;
        const lastMileMinutes = alight?.distanceMeters != null
            ? alight.distanceMeters / WALK_METERS_PER_MINUTE
            : 0;
        const rank = arrival.minutes + rideMinutes + lastMileMinutes;
        if (rank < bestRank) {
            bestRank = rank;
            best = {
                arrival,
                alight,
                totalMinutes: walkToStop + arrival.minutes + Math.round(rideMinutes),
            };
        }
    }
    return best;
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
    // serializeIdentity() provides a stable string key for the Map — identity objects are not primitives.
    const byIdentity = new Map();
    for (const c of candidates) {
        if (!c || typeof c.estimatedMinutes !== 'number' || !c.identity)
            continue;
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
export function cheapWalkToStop(me, stop, walkToStopCache) {
    if (!me || !stop)
        return 0;
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
    if (!candidate)
        return '';
    if (candidate.mode === 'walk') {
        return 'Ruta directa a pie';
    }
    const cMeta = candidate.metadata ?? {};
    const pMeta = primary?.metadata ?? {};
    const waitMins = candidate.breakdown?.waitMinutes ?? candidate.estimate?.waitMinutes;
    const walkMins = candidate.breakdown?.walkToStopMinutes ?? candidate.estimate?.walkToStopMinutes;
    // 1. Line difference
    if (cMeta.line && (!pMeta.line || String(cMeta.line) !== String(pMeta.line))) {
        const lineStr = String(cMeta.line).startsWith('L') ? cMeta.line : `Línea ${cMeta.line}`;
        const wait = waitMins != null ? ` · espera ${waitMins}′` : '';
        return `${lineStr}${wait}`;
    }
    // 2. Boarding stop difference
    const cBoard = String(cMeta.boardingStop?.stop ?? cMeta.boardingStop?.number ?? '');
    const pBoard = String(pMeta.boardingStop?.stop ?? pMeta.boardingStop?.number ?? '');
    if (cBoard && cBoard !== pBoard) {
        const boardName = cMeta.boardingStop?.name ? `Desde ${cMeta.boardingStop.name}` : 'Desde otra parada';
        const walk = walkMins != null ? ` (caminar ${walkMins}′)` : '';
        return `${boardName}${walk}`;
    }
    // 3. Alighting stop difference
    const cAlight = String(cMeta.alightStop?.stop ?? cMeta.alightStop?.number ?? '');
    const pAlight = String(pMeta.alightStop?.stop ?? pMeta.alightStop?.number ?? '');
    if (cAlight && cAlight !== pAlight) {
        return cMeta.alightStop?.name ? `Baja en ${cMeta.alightStop.name}` : 'Baja en otra parada';
    }
    // Default fallback
    if (waitMins != null) {
        return `Espera ${waitMins}′`;
    }
    return 'Opción alternativa';
}
