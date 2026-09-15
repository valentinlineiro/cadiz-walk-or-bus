let map, me, pins = new Map();

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
