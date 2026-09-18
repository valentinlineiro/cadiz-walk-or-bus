import {
  OsrmRoutingAdapter,
  MunicipalTransitAdapter,
  NominatimGeocodingAdapter,
  CADIZ_VIEWBOX,
} from './infrastructure/index.js';

export { CADIZ_VIEWBOX };

export async function getStops(fetchImpl) {
  return new MunicipalTransitAdapter(fetchImpl).getStops();
}

export async function getLines(fetchImpl) {
  return new MunicipalTransitAdapter(fetchImpl).getLines();
}

export async function getArrivals(fetchImpl, stop) {
  return new MunicipalTransitAdapter(fetchImpl).getArrivals(stop);
}

export async function searchDestinations(fetchImpl, q, limit = 3) {
  return new NominatimGeocodingAdapter(fetchImpl).search(q, limit);
}

export async function geocode(fetchImpl, q) {
  return new NominatimGeocodingAdapter(fetchImpl).geocode(q);
}

export async function walkRoute(fetchImpl, from, to) {
  return new OsrmRoutingAdapter(fetchImpl).routeWalking(from, to);
}

export async function busRoute(fetchImpl, stopCoords) {
  if (!Array.isArray(stopCoords) || stopCoords.length < 2) return null;
  const boarding = stopCoords[0];
  const alight = stopCoords[stopCoords.length - 1];
  const intermediate = stopCoords.slice(1, -1);
  const route = await new OsrmRoutingAdapter(fetchImpl).routeBus(boarding, alight, intermediate);
  return route?.coordinates ?? null;
}

// Temporary compatibility helpers without ports:
export async function walkMinutes(fetchImpl, from, to) {
  const res = await walkRoute(fetchImpl, from, to);
  return res ? res.minutes : null;
}

export async function driveMinutes(fetchImpl, from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  let r;
  try {
    r = await fetchImpl(url);
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const [route] = (await r.json()).routes ?? [];
  if (!route) return null;
  const speed = route.distance / route.duration;
  if (speed > 33 || speed < 2) return null;
  return Math.ceil(route.duration / 60);
}
