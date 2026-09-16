let map, me, destPin, alightPin, walkLine, busLine, pins = new Map();

// Inline SVG glyphs — no emoji on the map, each marker a distinct shape.
const SVG = {
  pin: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C7.6 2 4 5.6 4 10c0 6 8 12 8 12s8-6 8-12c0-4.4-3.6-8-8-8zm0 11a3 3 0 110-6 3 3 0 010 6z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 3v18h2v-6h9l-2.5-4L17 7H8V3z"/></svg>',
};

export function initMap(onPin, onMapClick) {
  map = L.map('map').setView([36.5271, -6.2885], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  map._onPin = onPin;
  if (onMapClick) {
    map.on('click', (e) => {
      onMapClick({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
  }
}

export function showMe(lat, lon) {
  if (!me) me = L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
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
    html: `<div title="${label ?? 'Destino'}" style="width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#111827;border:3px solid #fff;box-shadow:0 2px 8px rgba(17,24,39,.4)"><span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;transform:rotate(45deg);color:#fff">${SVG.pin}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 30],
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
    html: `<div title="Bajar en: ${stop.name}" style="height:28px;padding:0 10px;border-radius:14px;background:#2563eb;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:6px;border:2px solid #fff;box-shadow:0 2px 8px rgba(37,99,235,.45);white-space:nowrap"><span style="display:flex">${SVG.flag}</span><span>Bájate aquí</span></div>`,
    iconSize: [110, 28],
    iconAnchor: [55, 14],
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

// The bus's actual leg — routed over real roads between the stops it
// passes through (caller falls back to straight stop-to-stop segments if
// routing fails), not a walking-route guess over the same ground.
export function showBusRoute(coordinates) {
  if (busLine) {
    map.removeLayer(busLine);
    busLine = null;
  }
  if (!coordinates || coordinates.length < 2) return;
  busLine = L.polyline(coordinates, {
    color: '#2563eb',
    weight: 5,
    opacity: 0.85,
  }).addTo(map);
}

export function clearRoute() {
  if (destPin) { map.removeLayer(destPin); destPin = null; }
  if (alightPin) { map.removeLayer(alightPin); alightPin = null; }
  if (walkLine) { map.removeLayer(walkLine); walkLine = null; }
  if (busLine) { map.removeLayer(busLine); busLine = null; }
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
    pin.on('click', (e) => {
      if (e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      map._onPin(s.stop);
    });
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
  const size = Math.round(44 * style.scale);
  const fontSize = Math.round(15 * style.scale);
  return L.divIcon({
    className: 'stop-pin',
    html: `<div title="${name}" style="width:${size}px;height:${size}px;border-radius:50%;background:${COLORS[style.color]};color:#fff;font-weight:800;font-size:${fontSize}px;display:flex;align-items:center;justify-content:center;border:3px solid #fff;box-shadow:0 2px 8px rgba(17,24,39,.28)${style.halo ? ',0 0 0 6px rgba(217,119,6,.3)' : ''}">${style.label}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}
