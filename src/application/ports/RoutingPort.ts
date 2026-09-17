import type { Coordinates, Route } from '../../domain/models.js';

export interface RoutingPort {
  routeWalking(from: Coordinates, to: Coordinates): Promise<Route | null>;
  routeBus(
    boardingStop: Coordinates,
    alightingStop: Coordinates,
    intermediateStops?: Coordinates[],
  ): Promise<Route | null>;
}
