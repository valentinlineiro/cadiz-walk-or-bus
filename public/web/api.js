const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';

export async function getStops(fetchImpl) {
  const r = await fetchImpl('/stops');
  if (!r.ok) throw new Error(`stops ${r.status}`);
  return r.json();
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

export async function geocode(fetchImpl, q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
  const r = await fetchImpl(url);
  if (!r.ok) return null;
  const [hit] = await r.json();
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), name: hit.display_name } : null;
}

export async function walkMinutes(fetchImpl, from, to) {
  const url = `https://router.project-osrm.org/route/v1/foot/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const r = await fetchImpl(url);
  if (!r.ok) return null;
  const [route] = (await r.json()).routes ?? [];
  return route ? Math.ceil(route.duration / 60) : null;
}
