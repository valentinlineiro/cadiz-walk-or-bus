import type { RoutingPort } from '../ports/RoutingPort.js';
import type { TransitDataPort } from '../ports/TransitDataPort.js';
import type { Arrival, Coordinates, LinesTopology, Stop } from '../../domain/models.js';
import { chooseQuickBus } from '../../domain/planner.js';
import { findAlightStop, nearestStops, diversifyByLine } from '../../domain/topology.js';

export interface GetQuickVerdictInput {
  origin: Coordinates;
  destination: Coordinates & { label?: string };
}

export interface QuickVerdict {
  kind: 'walk' | 'bus';
  totalMinutes: number;
}

export class GetQuickVerdictUseCase {
  constructor(
    private readonly ports: {
      routing: RoutingPort;
      transit: TransitDataPort;
    },
  ) {}

  async execute(input: GetQuickVerdictInput): Promise<QuickVerdict | null> {
    const stops = await this.ports.transit.getStops();
    if (stops.length === 0) return null;

    const walkRoute = await this.ports.routing.routeWalking(input.origin, input.destination).catch(() => null);
    const walkTotal = walkRoute?.minutes ?? null;
    if (walkTotal == null) return null;

    const rawLines = await this.ports.transit.getLines();

    const lines: LinesTopology | null = rawLines
      ? ((rawLines as { lines?: LinesTopology }).lines ?? rawLines)
      : null;
    const pool = diversifyByLine(
      nearestStops(stops, input.origin.lat, input.origin.lon, 24),
      lines,
      6,
    );
    const arrivalsByStop = new Map<string, Arrival[]>(
      await Promise.all(pool.map(async (stop) => [
        stop.stop,
        await this.ports.transit.getArrivals(stop.stop),
      ] as const)),
    );

    let best: QuickVerdict | null = null;
    for (const stop of pool) {
      const walkToStopRoute = await this.ports.routing.routeWalking(input.origin, stop);
      const arrivals = arrivalsByStop.get(stop.stop) ?? [];
      const fastest = chooseQuickBus(
        arrivals,
        walkToStopRoute?.minutes,
        this.makeAlightResolver(stop, input.destination, stops, lines),
      );
      if (fastest && fastest.totalMinutes < walkTotal && (!best || fastest.totalMinutes < best.totalMinutes)) {
        best = { kind: 'bus', totalMinutes: fastest.totalMinutes };
      }
    }

    return best ?? { kind: 'walk', totalMinutes: walkTotal };
  }

  private makeAlightResolver(
    boardingStop: Stop,
    destination: Coordinates,
    stops: Stop[],
    lines: LinesTopology | null,
  ) {
    if (!lines) return null;
    return (arrival: Arrival) => findAlightStop({
      line: arrival.line,
      direction: arrival.destination,
      boardingStopId: boardingStop.stop,
      destCoords: destination,
      stops,
      lines,
    });
  }
}
