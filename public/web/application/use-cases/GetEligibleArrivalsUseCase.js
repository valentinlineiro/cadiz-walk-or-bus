import { arrivalsResultOf } from '../ports/TransitDataPort.js';
import { findAlightStop } from '../../domain/topology.js';
import { resolveEligibleArrivals } from '../../domain/planner.js';
export class GetEligibleArrivalsUseCase {
    ports;
    constructor(ports) {
        this.ports = ports;
    }
    async execute(input) {
        const [topologyStops, rawLines] = await Promise.all([
            this.ports.transit.getStops(),
            this.ports.transit.getLines(),
        ]);
        const lines = rawLines
            ? (rawLines.lines ?? rawLines)
            : null;
        const stops = topologyStops.length > 0 ? topologyStops : input.stops;
        const entries = await Promise.all(input.stops.map(async (boardingStop) => {
            const result = await arrivalsResultOf(this.ports.transit, boardingStop.stop);
            const arrivals = result.status === 'unavailable' ? [] : result.arrivals;
            const eligible = resolveEligibleArrivals(arrivals, lines
                ? (arrival) => findAlightStop({
                    line: arrival.line,
                    direction: arrival.destination,
                    boardingStopId: boardingStop.stop,
                    destCoords: input.destination,
                    stops,
                    lines,
                })
                : null);
            return [boardingStop.stop, eligible];
        }));
        return new Map(entries);
    }
}
