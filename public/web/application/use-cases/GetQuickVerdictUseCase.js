import { arrivalsResultOf } from '../ports/TransitDataPort.js';
import { chooseQuickBus } from '../../domain/planner.js';
import { findAlightStop, nearestStops, diversifyByLine } from '../../domain/topology.js';
export class GetQuickVerdictUseCase {
    ports;
    constructor(ports) {
        this.ports = ports;
    }
    async execute(input) {
        const stops = await this.ports.transit.getStops();
        if (stops.length === 0)
            return null;
        const walkRoute = await this.ports.routing.routeWalking(input.origin, input.destination).catch(() => null);
        const walkTotal = walkRoute?.minutes ?? null;
        if (walkTotal == null)
            return null;
        const rawLines = await this.ports.transit.getLines();
        const lines = rawLines
            ? (rawLines.lines ?? rawLines)
            : null;
        const pool = diversifyByLine(nearestStops(stops, input.origin.lat, input.origin.lon, 24), lines, 6);
        const results = await Promise.all(pool.map(async (stop) => [
            stop.stop,
            await arrivalsResultOf(this.ports.transit, stop.stop),
        ]));
        // No stop answered (live or scheduled): "walk" would be a guess, so give no verdict.
        if (pool.length > 0 && results.every(([, result]) => result.status === 'unavailable'))
            return null;
        const arrivalsByStop = new Map(results.map(([id, result]) => [id, result.status === 'unavailable' ? [] : result.arrivals]));
        let best = null;
        for (const stop of pool) {
            const walkToStopRoute = await this.ports.routing.routeWalking(input.origin, stop);
            const arrivals = arrivalsByStop.get(stop.stop) ?? [];
            const fastest = chooseQuickBus(arrivals, walkToStopRoute?.minutes, this.makeAlightResolver(stop, input.destination, stops, lines));
            if (fastest && fastest.totalMinutes < walkTotal && (!best || fastest.totalMinutes < best.totalMinutes)) {
                best = { kind: 'bus', totalMinutes: fastest.totalMinutes };
            }
        }
        return best ?? { kind: 'walk', totalMinutes: walkTotal };
    }
    makeAlightResolver(boardingStop, destination, stops, lines) {
        if (!lines)
            return null;
        return (arrival) => findAlightStop({
            line: arrival.line,
            direction: arrival.destination,
            boardingStopId: boardingStop.stop,
            destCoords: destination,
            stops,
            lines,
        });
    }
}
