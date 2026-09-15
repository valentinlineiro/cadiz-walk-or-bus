const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';

export async function getStops(fetchImpl) {
  const r = await fetchImpl('/stops');
  if (!r.ok) throw new Error(`stops ${r.status}`);
  return r.json();
}

export async function getLines(fetchImpl) {
  let r;
  try {
    r = await fetchImpl('/lines');
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const data = await r.json();
  return data?.lines ?? null;
}

export async function getArrivals(fetchImpl, stop) {
  let r;
  try {
    r = await fetchImpl(`/api?stop=${encodeURIComponent(stop)}`);
  } catch {
    return [];
  }
  if (!r.ok) return [];
  return (await r.json()).arrivals ?? [];
}

export async function searchDestinations(fetchImpl, q, limit = 3) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
  let r;
  try {
    r = await fetchImpl(url);
  } catch {
    return [];
  }
  if (!r.ok) return [];
  const hits = await r.json();
  if (!Array.isArray(hits)) return [];
  return hits.map((hit) => {
    const main = hit.name || hit.display_name.split(',')[0].trim();
    const parts = hit.display_name.split(',').map((p) => p.trim());
    const sub = parts.length > 1 ? parts.slice(1, 3).join(', ') : '';
    return {
      label: main,
      sub,
      lat: Number(hit.lat),
      lon: Number(hit.lon),
    };
  });
}

export async function geocode(fetchImpl, q) {
  const hits = await searchDestinations(fetchImpl, q, 1);
  return hits.length > 0 ? { lat: hits[0].lat, lon: hits[0].lon, name: hits[0].label } : null;
}

// The public router.project-osrm.org demo has no real foot profile — its
// /foot/ route silently serves the car graph (same distance/duration as
// /driving/, one-way streets and all), producing walking detours ~2x too
// long. FOSSGIS's routed-foot mirror is an actual pedestrian graph.
export async function walkRoute(fetchImpl, from, to) {
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  let r;
  try {
    r = await fetchImpl(url);
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const data = await r.json();
  const [route] = data.routes ?? [];
  if (!route) return null;
  const speed = route.distance / route.duration;
  const minutes = (speed > 3.5 || speed < 0.5)
    ? Math.ceil(route.distance / (5000 / 60))
    : Math.ceil(route.duration / 60);
  const rawCoords = route.geometry?.coordinates ?? [];
  const coordinates = rawCoords.map(([lon, lat]) => [lat, lon]);
  return { minutes, coordinates };
}

export async function walkMinutes(fetchImpl, from, to) {
  const res = await walkRoute(fetchImpl, from, to);
  return res ? res.minutes : null;
}

// Roads the bus actually drives on, through every stop it passes — the
// driving graph (unlike /foot/ above) is real on the public OSRM demo.
export async function busRoute(fetchImpl, stopCoords) {
  if (!Array.isArray(stopCoords) || stopCoords.length < 2) return null;
  const waypoints = stopCoords.map((s) => `${s.lon},${s.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${waypoints}?overview=full&geometries=geojson`;
  let r;
  try {
    r = await fetchImpl(url);
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const [route] = (await r.json()).routes ?? [];
  const rawCoords = route?.geometry?.coordinates ?? [];
  if (rawCoords.length < 2) return null;
  return rawCoords.map(([lon, lat]) => [lat, lon]);
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
