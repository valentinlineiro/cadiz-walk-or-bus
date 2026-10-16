import { haversineMeters } from '../../domain/topology.js';
import { walkMinutes } from '../../domain/walking.js';
export class OsrmRoutingAdapter {
    fetchImpl;
    footBaseUrl;
    driveBaseUrl;
    constructor(fetchImpl = globalThis.fetch, options = {}) {
        this.fetchImpl = (fetchImpl ?? globalThis.fetch).bind(globalThis);
        this.footBaseUrl = options.footBaseUrl ?? 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
        this.driveBaseUrl = options.driveBaseUrl ?? 'https://router.project-osrm.org/route/v1/driving';
    }
    async routeWalking(from, to) {
        const url = `${this.footBaseUrl}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
        let r;
        try {
            r = await this.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
        }
        catch {
            return { status: 'service_failure', coordinates: [] };
        }
        if (r.status >= 500) {
            return { status: 'service_failure', coordinates: [] };
        }
        if (!r.ok)
            return null;
        let data;
        try {
            data = await r.json();
        }
        catch {
            return { status: 'service_failure', coordinates: [] };
        }
        const [route] = data.routes ?? [];
        if (!route || data.code === 'NoRoute')
            return null;
        // Reject degenerate routes shorter than straight line
        if (route.distance < haversineMeters(from.lat, from.lon, to.lat, to.lon) * 0.95) {
            return null;
        }
        const speed = route.distance / route.duration;
        const minutes = (speed > 3.5 || speed < 0.5)
            ? walkMinutes(route.distance)
            : Math.ceil(route.duration / 60);
        const rawCoords = route.geometry?.coordinates ?? [];
        const coordinates = rawCoords.map(([lon, lat]) => [lat, lon]);
        return { status: 'available', minutes, coordinates };
    }
    async busRouteHop(from, to) {
        const straightLine = () => [[from.lat, from.lon], [to.lat, to.lon]];
        const url = `${this.driveBaseUrl}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
        let r;
        try {
            r = await this.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
        }
        catch {
            return straightLine();
        }
        if (!r.ok)
            return straightLine();
        let data;
        try {
            data = await r.json();
        }
        catch {
            return straightLine();
        }
        const [route] = data.routes ?? [];
        const rawCoords = route?.geometry?.coordinates ?? [];
        if (rawCoords.length < 2 || route.distance < haversineMeters(from.lat, from.lon, to.lat, to.lon) * 0.95) {
            return straightLine();
        }
        return rawCoords.map(([lon, lat]) => [lat, lon]);
    }
    async routeBus(boardingStop, alightingStop, intermediateStops) {
        const stopCoords = [
            boardingStop,
            ...(intermediateStops ?? []),
            alightingStop,
        ];
        if (stopCoords.length < 2)
            return null;
        const hops = await Promise.all(stopCoords.slice(0, -1).map((from, i) => this.busRouteHop(from, stopCoords[i + 1])));
        const coordinates = [];
        for (const hop of hops) {
            if (coordinates.length > 0)
                coordinates.pop(); // drop duplicate junction point
            coordinates.push(...hop);
        }
        return coordinates.length >= 2 ? { coordinates } : null;
    }
}
