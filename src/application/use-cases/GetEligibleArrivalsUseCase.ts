import type { TransitDataPort } from '../ports/TransitDataPort.js';
import type { Arrival, Coordinates, LinesTopology, Stop } from '../../domain/models.js';
import { filterCandidates } from '../../domain/decision.js';
import { findAlightStop } from '../../domain/topology.js';

export interface GetEligibleArrivalsInput {
  stops: Stop[];
  destination: Coordinates;
}

export class GetEligibleArrivalsUseCase {
  constructor(private readonly ports: { transit: TransitDataPort }) {}

  async execute(input: GetEligibleArrivalsInput): Promise<Map<string, Arrival[]>> {
    const [topologyStops, rawLines] = await Promise.all([
      this.ports.transit.getStops(),
      this.ports.transit.getLines(),
    ]);
    const lines: LinesTopology | null = rawLines
      ? ((rawLines as { lines?: LinesTopology }).lines ?? rawLines)
      : null;
    const stops = topologyStops.length > 0 ? topologyStops : input.stops;

    const entries = await Promise.all(input.stops.map(async (boardingStop) => {
      const arrivals = await this.ports.transit.getArrivals(boardingStop.stop).catch(() => [] as Arrival[]);
      const eligible = filterCandidates(arrivals, lines
        ? (arrival) => findAlightStop({
          line: arrival.line,
          direction: arrival.destination,
          boardingStopId: boardingStop.stop,
          destCoords: input.destination,
          stops,
          lines,
        })
        : null);
      return [boardingStop.stop, eligible] as const;
    }));

    return new Map(entries);
  }
}
