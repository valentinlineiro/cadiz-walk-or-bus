import type { RoutingPort } from '../ports/RoutingPort.js';
import type { TransitDataPort } from '../ports/TransitDataPort.js';
import type {
  Coordinates,
  Decision,
  DecisionAlternative,
  EvaluatedJourney,
  JourneyCandidate,
  Stop,
  LinesTopology,
} from '../../domain/models.js';
import {
  WALK_METERS_PER_MINUTE,
  DEFAULT_PLANNING_POLICY,
  type PlanningPolicyOverrides,
} from '../../domain/constants.js';
import { computeLastMile } from '../../domain/last-mile.js';
import { filterDiverseAlternatives } from '../../domain/diversity.js';
import { haversineMeters, findAlightStop } from '../../domain/topology.js';
import { createWalkCandidate, createBusCandidates, selectCandidates } from '../../domain/planner.js';

export interface FindBestJourneysInput {
  origin: Coordinates;
  destination: Coordinates & { label?: string };
  policy?: PlanningPolicyOverrides;
}

export class FindBestJourneysUseCase {
  constructor(
    private readonly ports: {
      routing: RoutingPort;
      transit: TransitDataPort;
    },
  ) {}

  async execute(input: FindBestJourneysInput): Promise<Decision> {
    const policy = { ...DEFAULT_PLANNING_POLICY, ...input.policy };
    const { origin, destination } = input;

    // 1. CHEAP CANDIDATES GENERATION (Zero network routing calls upfront)
    const directDist = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon);
    const cheapWalkMinutes = Math.max(1, Math.round(directDist / WALK_METERS_PER_MINUTE));

    const walkCandidate = createWalkCandidate({
      walkMinutes: cheapWalkMinutes,
      origin,
      destination,
    });

    const [stops, rawLines] = await Promise.all([
      this.ports.transit.getStops().catch(() => [] as Stop[]),
      this.ports.transit.getLines().catch(() => null),
    ]);

    const lines: LinesTopology | null = rawLines
      ? ((rawLines as any).lines ?? rawLines)
      : null;

    // Nearby stops sorted by proximity
    const nearbyStops = stops
      .map((s) => ({ ...s, dist: haversineMeters(origin.lat, origin.lon, s.lat, s.lon) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);

    const busCandidates: JourneyCandidate[] = [];
    await Promise.all(
      nearbyStops.map(async (stop) => {
        const arrivals = await this.ports.transit.getArrivals(stop.stop).catch(() => []);
        const walkToStopMinutes = Math.max(0, Math.round(stop.dist / WALK_METERS_PER_MINUTE));

        const resolveAlight = (arr: any) => {
          if (!lines) return null;
          // Try standard findAlightStop first
          const res = findAlightStop({
            line: arr.line,
            direction: arr.destination,
            boardingStopId: stop.stop,
            destCoords: destination,
            stops,
            lines,
          });
          if (res) return res;

          // Fallback sequence traversal if lines format is structured with directions array or custom shape
          const lineDef = (lines as any)[arr.line];
          if (!lineDef) return null;

          // If lineDef has directions array (e.g. { directions: [{ stops: [...] }] })
          if (Array.isArray(lineDef.directions)) {
            for (const dir of lineDef.directions) {
              const bIdx = dir.stops?.indexOf(stop.stop);
              if (bIdx != null && bIdx >= 0 && dir.stops) {
                for (let i = bIdx + 1; i < dir.stops.length; i++) {
                  const candidateStopId = dir.stops[i];
                  const sObj = stops.find((s) => s.stop === candidateStopId);
                  if (sObj) {
                    const alightDist = haversineMeters(sObj.lat, sObj.lon, destination.lat, destination.lon);
                    const boardingDist = haversineMeters(stop.lat, stop.lon, destination.lat, destination.lon);
                    if (alightDist < boardingDist) {
                      return {
                        stop: sObj,
                        alightStop: sObj,
                        distanceMeters: alightDist,
                        alightDistanceMeters: alightDist,
                        rideMinutes: Math.max(1, (i - bIdx) * 2),
                        path: dir.stops.slice(bIdx, i + 1).map((sid: string) => stops.find((s) => s.stop === sid)).filter(Boolean),
                      };
                    }
                  }
                }
              }
            }
          }

          return null;
        };

        const cands = createBusCandidates({
          arrivals,
          stop,
          walkToStopMinutes,
          resolveAlight,
        });
        busCandidates.push(...cands);
      }),
    );

    // 2. CHEAP SELECTION GATE (Hard budget enforcement <= 3)
    const { primary: cheapPrimary, alternatives: cheapAlternatives } = selectCandidates(
      [walkCandidate, ...busCandidates],
      policy,
    );
    const selected = cheapPrimary ? [cheapPrimary, ...cheapAlternatives] : [walkCandidate];

    // 3. CONCURRENT EXACT ROUTING (Only for admitted <= 3 candidates)
    const evaluatedJourneys: EvaluatedJourney[] = await Promise.all(
      selected.map(async (cand: any): Promise<EvaluatedJourney> => {
        if (cand.mode === 'walk') {
          const routedWalk = await this.ports.routing.routeWalking(origin, destination).catch(() => null);
          const totalMins = routedWalk?.minutes ?? cand.estimatedMinutes;
          return {
            identity: cand.identity,
            mode: 'walk',
            totalMinutes: totalMins,
            dataQuality: routedWalk ? 'live' : 'degraded',
            breakdown: {
              walkToStopMinutes: 0,
              waitMinutes: 0,
              rideMinutes: 0,
              lastMileMinutes: totalMins,
              lastMileDegraded: !routedWalk,
            },
            routes: { walkRoute: routedWalk },
            metadata: cand.metadata,
          };
        }

        // Bus candidate exact legs
        const boardStop = cand.metadata?.boardingStop;
        const alightStop = cand.metadata?.alightStop;
        const pathCoords = cand.metadata?.path?.map((p: any) => ({ lat: p.lat, lon: p.lon })) ?? [];

        const [walkToStopRoute, routedBus, lastMileRoute] = await Promise.all([
          boardStop ? this.ports.routing.routeWalking(origin, boardStop).catch(() => null) : null,
          boardStop && alightStop
            ? this.ports.routing.routeBus(boardStop, alightStop, pathCoords).catch(() => null)
            : null,
          alightStop ? this.ports.routing.routeWalking(alightStop, destination).catch(() => null) : null,
        ]);

        const { lastMileMinutes, lastMileDegraded } = computeLastMile(
          lastMileRoute,
          cand.metadata?.alightDistanceMeters ?? 0,
        );
        const walkToStopMins = walkToStopRoute?.minutes ?? cand.estimate.walkToStopMinutes ?? 0;
        const totalMinutes =
          walkToStopMins + (cand.estimate.waitMinutes ?? 0) + (cand.estimate.rideMinutes ?? 0) + lastMileMinutes;

        return {
          identity: cand.identity,
          mode: 'bus',
          totalMinutes,
          dataQuality: lastMileDegraded ? 'degraded' : 'live',
          breakdown: {
            walkToStopMinutes: walkToStopMins,
            waitMinutes: cand.estimate.waitMinutes ?? 0,
            rideMinutes: cand.estimate.rideMinutes ?? 0,
            lastMileMinutes,
            lastMileDegraded,
          },
          routes: {
            walkToStopRoute,
            busRoute: routedBus,
            lastMileRoute,
          },
          metadata: cand.metadata,
        };
      }),
    );

    // 4. EXACT RE-RANKING (Definitive Hero Selection)
    const reRankItems = evaluatedJourneys.map((j) => ({
      ...j,
      estimatedMinutes: j.totalMinutes,
      journey: j,
    }));
    const { primary: finalPrimaryItem, alternatives: finalAltItems } = selectCandidates(reRankItems, policy);

    const finalHero: EvaluatedJourney = (finalPrimaryItem as any)?.journey ?? evaluatedJourneys[0];
    const candidateAlternatives: EvaluatedJourney[] = (finalAltItems as any[]).map((item) => item.journey);

    // 5. DIVERSITY FILTERING AGAINST FINAL HERO
    const diverseAlternatives = filterDiverseAlternatives(candidateAlternatives, finalHero, policy);

    // 6. ASSEMBLE DECISION
    const alternatives: DecisionAlternative[] = diverseAlternatives.map((alt) => {
      const deltaMinutes = alt.totalMinutes - finalHero.totalMinutes;
      const divergenceType = alt.mode !== finalHero.mode
        ? 'mode'
        : alt.metadata?.line !== finalHero.metadata?.line
          ? 'line'
          : 'access';
      const differentiator = alt.mode === 'walk'
        ? 'Ruta directa a pie'
        : `Línea ${alt.metadata?.line ?? ''} · espera ${alt.breakdown.waitMinutes}′`;

      return {
        journey: alt,
        differentiator,
        deltaMinutes,
        divergenceType,
      };
    });

    return {
      hero: finalHero,
      alternatives,
    };
  }
}
