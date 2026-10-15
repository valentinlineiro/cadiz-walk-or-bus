import type { RoutingPort } from '../ports/RoutingPort.js';
import { arrivalsResultOf, type TransitDataPort } from '../ports/TransitDataPort.js';
import type {
  Arrival,
  Coordinates,
  Decision,
  DecisionAlternative,
  EvaluatedJourney,
  JourneyCandidate,
  LinesTopology,
  Route,
  Stop,
  TransitDataStatus,
} from '../../domain/models.js';
import type { JourneyIdentity } from '../../domain/identity.js';
import {
  WALK_METERS_PER_MINUTE,
  DEFAULT_PLANNING_POLICY,
  type PlanningPolicyOverrides,
} from '../../domain/constants.js';
import { computeLastMile } from '../../domain/last-mile.js';
import { filterDiverseAlternatives, type StructurallyDiverseItem } from '../../domain/diversity.js';
import { haversineMeters, findAlightStop, nearestStops, diversifyByLine } from '../../domain/topology.js';
import { createWalkCandidate, createBusCandidates, selectCandidates } from '../../domain/planner.js';

export interface FindBestJourneysInput {
  origin: Coordinates;
  destination: Coordinates & { label?: string };
  policy?: PlanningPolicyOverrides;
  /** Bus route geometry costs one routing call per hop and is only needed to draw the map. */
  withBusGeometry?: boolean;
}

interface ReRankItem extends StructurallyDiverseItem {
  identity: JourneyIdentity;
  journey: EvaluatedJourney;
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
      this.ports.transit.getStops().catch(() => null as Stop[] | null),
      this.ports.transit.getLines().catch(() => null as LinesTopology | null),
    ]);

    const lines: LinesTopology | null = rawLines
      ? ((rawLines as { lines?: LinesTopology }).lines ?? rawLines)
      : null;

    // Nearby stops pool prioritized and diversified by line
    const stopsLoaded = stops !== null;
    const pool = nearestStops(stops ?? [], origin.lat, origin.lon, 32);
    const nearbyStops = lines ? diversifyByLine(pool, lines, 8) : pool.slice(0, 8);

    const busCandidates: JourneyCandidate[] = [];
    let stopsWithData = 0;
    await Promise.all(
      nearbyStops.map(async (stop) => {
        const result = await arrivalsResultOf(this.ports.transit, stop.stop);
        // `[]` below is only ever "a source answered with nothing"; a source that did not answer
        // is counted separately so the caller can refuse to recommend walking on missing data.
        if (result.status !== 'unavailable') stopsWithData += 1;
        const arrivals: Arrival[] = result.status === 'unavailable' ? [] : result.arrivals;
        const stopDist = haversineMeters(origin.lat, origin.lon, stop.lat, stop.lon);
        const walkToStopMinutes = Math.max(0, Math.round(stopDist / WALK_METERS_PER_MINUTE));

        const resolveAlight = (arr: Arrival) => {
          if (!lines) return null;
          return findAlightStop({
            line: arr.line,
            direction: arr.destination,
            boardingStopId: stop.stop,
            destCoords: destination,
            stops: stops ?? [],
            lines,
          });
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

    // Without the line topology no bus can be matched to the destination: buses were not
    // evaluated, so "walk" would be a guess, not a conclusion.
    const transitData: TransitDataStatus =
      !stopsLoaded || !lines
        ? 'unavailable'
        : nearbyStops.length === 0 || stopsWithData === nearbyStops.length
        ? 'available'
        : stopsWithData === 0
          ? 'unavailable'
          : 'partial';

    // 2. CHEAP SELECTION GATE (Hard budget enforcement <= 3)
    const { primary: cheapPrimary, alternatives: cheapAlternatives } = selectCandidates(
      [walkCandidate, ...busCandidates],
      policy,
    );
    const selected: JourneyCandidate[] = cheapPrimary ? [cheapPrimary, ...cheapAlternatives] : [walkCandidate];

    // 3. CONCURRENT EXACT ROUTING (Only for admitted <= 3 candidates)
    const rawEvaluated = await Promise.all(
      selected.map(async (cand: JourneyCandidate): Promise<EvaluatedJourney | null> => {
        if (cand.mode === 'walk') {
          let routedWalk: Route | null = null;
          let isServiceFailure = false;
          try {
            routedWalk = await this.ports.routing.routeWalking(origin, destination);
            if (routedWalk && routedWalk.status === 'service_failure') {
              isServiceFailure = true;
              routedWalk = null;
            }
          } catch {
            isServiceFailure = true;
            routedWalk = null;
          }

          if (routedWalk && typeof routedWalk.minutes === 'number' && routedWalk.status !== 'unavailable') {
            const totalMins = routedWalk.minutes;
            return {
              identity: cand.identity,
              mode: 'walk',
              totalMinutes: totalMins,
              dataQuality: 'live',
              breakdown: {
                walkToStopMinutes: 0,
                waitMinutes: 0,
                rideMinutes: 0,
                lastMileMinutes: totalMins,
                lastMileDegraded: false,
              },
              routes: { walkRoute: routedWalk },
              metadata: cand.metadata,
            };
          } else if (isServiceFailure) {
            // Service failure (OSRM timeout, 5xx, network error): degraded walk candidate
            const totalMins = cand.estimatedMinutes;
            return {
              identity: cand.identity,
              mode: 'walk',
              totalMinutes: totalMins,
              dataQuality: 'degraded',
              breakdown: {
                walkToStopMinutes: 0,
                waitMinutes: 0,
                rideMinutes: 0,
                lastMileMinutes: totalMins,
                lastMileDegraded: true,
              },
              routes: { walkRoute: null },
              metadata: cand.metadata,
            };
          } else {
            // Route unavailable (ocean, inaccessible pedestrian): candidate cannot be reached on foot
            return null;
          }
        }

        // Bus candidate exact legs
        const boardStop = cand.metadata?.boardingStop;
        const alightStop = cand.metadata?.alightStop;
        const pathCoords = cand.metadata?.path?.map((p) => ({ lat: p.lat, lon: p.lon })) ?? [];

        const [walkToStopRoute, routedBus, lastMileRoute] = await Promise.all([
          boardStop ? this.ports.routing.routeWalking(origin, boardStop).catch(() => null) : null,
          boardStop && alightStop && input.withBusGeometry !== false
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
          dataQuality: lastMileDegraded ? 'degraded' : cand.dataQuality,
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
    const evaluatedJourneys: EvaluatedJourney[] = rawEvaluated.filter(
      (j): j is EvaluatedJourney => j !== null,
    );

    if (evaluatedJourneys.length === 0) {
      return {
        hero: null,
        alternatives: [],
        walkMinutes: null,
        transitData,
      };
    }

    // 4. EXACT RE-RANKING (Definitive Hero Selection)
    const reRankItems: ReRankItem[] = evaluatedJourneys.map((j) => ({
      identity: j.identity,
      mode: j.mode,
      estimatedMinutes: j.totalMinutes,
      metadata: j.metadata,
      estimate: {
        walkToStopMinutes: j.breakdown.walkToStopMinutes,
        waitMinutes: j.breakdown.waitMinutes,
        rideMinutes: j.breakdown.rideMinutes,
        lastMileMinutes: j.breakdown.lastMileMinutes,
      },
      exactJourney: {
        totalMinutes: j.totalMinutes,
        walkToStopRoute: j.routes.walkToStopRoute,
        busRoute: j.routes.busRoute,
        lastMileRoute: j.routes.lastMileRoute,
        lastMileMinutes: j.breakdown.lastMileMinutes,
        lastMileDegraded: j.breakdown.lastMileDegraded,
        walkRoute: j.routes.walkRoute,
      },
      journey: j,
    }));
    const { primary: finalPrimaryItem, alternatives: finalAltItems } = selectCandidates<ReRankItem>(
      reRankItems,
      policy,
    );

    const finalHero: EvaluatedJourney = finalPrimaryItem ? finalPrimaryItem.journey : evaluatedJourneys[0];
    const candidateAlternatives: EvaluatedJourney[] = finalAltItems.map((item) => item.journey);

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

    const exactWalk = evaluatedJourneys.find((journey) => journey.mode === 'walk');

    return {
      hero: finalHero,
      alternatives,
      walkMinutes: exactWalk ? exactWalk.totalMinutes : null,
      transitData,
    };
  }
}
