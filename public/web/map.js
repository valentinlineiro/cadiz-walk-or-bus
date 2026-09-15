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
    const label = arr.length === 0 ? '—' : `${Math.min(...arr.map((a) => a.minutes))}′`;
    const pin = L.marker([s.lat, s.lon]).addTo(map).bindTooltip(`${s.name} · ${label}`);
    pin.on('click', () => map._onPin(s.stop));
    if (s.stop === focused) pin.openTooltip();
    pins.set(s.stop, pin);
  }
}
