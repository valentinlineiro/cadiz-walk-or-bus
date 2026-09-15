let map, me, destPin, alightPin, walkLine, pins = new Map();

export function initMap(onPin) {
  map = L.map('map').setView([36.5271, -6.2885], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  map._onPin = onPin;
}

export function showMe(lat, lon) {
  if (!me) me = L.circleMarker([lat, lon], { radius: 8, color: '#1a73e8' }).addTo(map);
  else me.setLatLng([lat, lon]);
  map.setView([lat, lon], 15);
}

export function showDestination(lat, lon, label) {
  if (destPin) {
    map.removeLayer(destPin);
    destPin = null;
  }
  if (lat == null || lon == null) return;
  const icon = L.divIcon({
    className: 'dest-pin',
    html: `<div title="${label ?? 'Destino'}" style="width:36px;height:36px;border-radius:50%;background:#dc2626;color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)">📍</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
  destPin = L.marker([lat, lon], { icon }).addTo(map);
}

export function showAlightStop(stop) {
  if (alightPin) {
    map.removeLayer(alightPin);
    alightPin = null;
  }
  if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
  const icon = L.divIcon({
    className: 'alight-pin',
    html: `<div title="Bajar en: ${stop.name}" style="height:28px;padding:0 8px;border-radius:14px;background:#2563eb;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:4px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);white-space:nowrap"><span>🚏</span><span>Bajar aquí</span></div>`,
    iconSize: [100, 28],
    iconAnchor: [50, 14],
  });
  alightPin = L.marker([stop.lat, stop.lon], { icon }).addTo(map);
}

export function showWalkRoute(coordinates) {
  if (walkLine) {
    map.removeLayer(walkLine);
    walkLine = null;
  }
  if (!coordinates || coordinates.length === 0) return;
  walkLine = L.polyline(coordinates, {
    color: '#16a34a',
    weight: 5,
    opacity: 0.85,
    dashArray: '8, 8',
  }).addTo(map);
}

export function clearRoute() {
  if (destPin) { map.removeLayer(destPin); destPin = null; }
  if (alightPin) { map.removeLayer(alightPin); alightPin = null; }
  if (walkLine) { map.removeLayer(walkLine); walkLine = null; }
}

export function fitRoute(points) {
  if (!map || !points || points.length === 0) return;
  const valid = points
    .filter((p) => p && ((Number.isFinite(p.lat) && Number.isFinite(p.lon)) || (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))))
    .map((p) => (Array.isArray(p) ? p : [p.lat, p.lon]));
  if (valid.length === 0) return;
  if (valid.length === 1) {
    map.setView(valid[0], 15);
    return;
  }
  map.fitBounds(valid, {
    paddingTopLeft: [30, 80],
    paddingBottomRight: [30, 210],
    maxZoom: 17,
  });
}

export function showStops(stops, arrivalsByStop, focused) {
  for (const [id, pin] of pins) { map.removeLayer(pin); pins.delete(id); }
  for (const s of stops) {
    const arr = arrivalsByStop.get(s.stop) ?? [];
    const pin = L.marker([s.lat, s.lon], { icon: pinIcon(pinStyle(arr, s.stop === focused), s.name) }).addTo(map);
    pin.on('click', () => map._onPin(s.stop));
    pins.set(s.stop, pin);
  }
}

export function pinStyle(arrivals, focused) {
  if (arrivals.length === 0) return { label: '—', color: 'gray', scale: 1, halo: false };
  const minutes = Math.min(...arrivals.map((a) => a.minutes));
  return { label: `${minutes}′`, color: 'amber', scale: focused ? 1.25 : 1, halo: focused };
}

const COLORS = { amber: '#d97706', gray: '#9ca3af' };

function pinIcon(style, name) {
  const size = Math.round(48 * style.scale);
  return L.divIcon({
    className: 'stop-pin',
    html: `<div title="${name}" style="width:${size}px;height:${size}px;border-radius:50%;background:${COLORS[style.color]};color:#fff;font-weight:800;font-size:18px;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.3)${style.halo ? ',0 0 0 6px rgba(217,119,6,.35)' : ''}">${style.label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}
