import type { Coordinates, Route } from '../../domain/models.js';

export interface RoutingPort {
  /**
   * Computes an exact walking route with duration and coordinates.
   */
  routeWalking(from: Coordinates, to: Coordinates): Promise<Route | null>;

  /**
   * Computes exact road polyline geometry for bus transit legs.
   * Note: Transit ride duration is derived from scheduled topology estimates,
   * while this method provides exact geometry for visual map rendering.
   */
  routeBus(
    boardingStop: Coordinates,
    alightingStop: Coordinates,
    intermediateStops?: Coordinates[],
  ): Promise<Route | null>;
}
