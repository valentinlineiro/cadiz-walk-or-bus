import type { RoutingPort } from '../../application/ports/RoutingPort.js';
import type { Coordinates, Route } from '../../domain/models.js';
import { haversineMeters } from '../../domain/topology.js';

export class OsrmRoutingAdapter implements RoutingPort {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async routeWalking(from: Coordinates, to: Coordinates): Promise<Route | null> {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    let r: Response;
    try {
      r = await this.fetchImpl(url);
    } catch {
      return null;
    }
    if (!r.ok) return null;

    let data: any;
    try {
      data = await r.json();
    } catch {
      return null;
    }

    const [route] = data.routes ?? [];
    if (!route) return null;

    // Reject degenerate routes shorter than straight line
    if (route.distance < haversineMeters(from.lat, from.lon, to.lat, to.lon) * 0.95) {
      return null;
    }

    const speed = route.distance / route.duration;
    const minutes = (speed > 3.5 || speed < 0.5)
      ? Math.ceil(route.distance / (5000 / 60))
      : Math.ceil(route.duration / 60);

    const rawCoords: [number, number][] = route.geometry?.coordinates ?? [];
    const coordinates: [number, number][] = rawCoords.map(([lon, lat]) => [lat, lon]);
    return { minutes, coordinates };
  }

  private async busRouteHop(from: Coordinates, to: Coordinates): Promise<[number, number][]> {
    const straightLine = (): [number, number][] => [[from.lat, from.lon], [to.lat, to.lon]];
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    let r: Response;
    try {
      r = await this.fetchImpl(url);
    } catch {
      return straightLine();
    }
    if (!r.ok) return straightLine();

    let data: any;
    try {
      data = await r.json();
    } catch {
      return straightLine();
    }

    const [route] = data.routes ?? [];
    const rawCoords: [number, number][] = route?.geometry?.coordinates ?? [];

    if (rawCoords.length < 2 || route.distance < haversineMeters(from.lat, from.lon, to.lat, to.lon) * 0.95) {
      return straightLine();
    }
    return rawCoords.map(([lon, lat]) => [lat, lon]);
  }

  async routeBus(
    boardingStop: Coordinates,
    alightingStop: Coordinates,
    intermediateStops?: Coordinates[],
  ): Promise<Route | null> {
    const stopCoords: Coordinates[] = [
      boardingStop,
      ...(intermediateStops ?? []),
      alightingStop,
    ];

    if (stopCoords.length < 2) return null;

    const hops = await Promise.all(
      stopCoords.slice(0, -1).map((from, i) => this.busRouteHop(from, stopCoords[i + 1])),
    );

    const coordinates: [number, number][] = [];
    for (const hop of hops) {
      if (coordinates.length > 0) coordinates.pop(); // drop duplicate junction point
      coordinates.push(...hop);
    }

    return coordinates.length >= 2 ? { coordinates } : null;
  }
}
