const R = 6371;
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearestStops(stops, lat, lon, n = 3) {
  return stops
    .map((s) => ({ ...s, _km: haversine(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a._km - b._km)
    .slice(0, n);
}

// Viewbox string format: 'west,north,east,south' (Nominatim convention).
export const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';
const [lonMin, latMax, lonMax, latMin] = CADIZ_VIEWBOX.split(',').map(Number);
export const CADIZ_BBOX = { latMin, latMax, lonMin, lonMax };

export const CADIZ_SERVICE_AREA_POLYGON = [
  [36.545, -6.280], // Dique de Levante
  [36.545, -6.295], // Punta de San Felipe
  [36.539, -6.303], // Baluarte de la Candelaria / Alameda
  [36.536, -6.313], // Castillo Santa Catalina
  [36.532, -6.313], // La Caleta
  [36.527, -6.326], // Castillo San Sebastián (westernmost tip)
  [36.524, -6.300], // Campo del Sur
  [36.518, -6.290], // Santa María del Mar
  [36.500, -6.283], // Playa Victoria
  [36.480, -6.275], // Cortadura playa
  [36.465, -6.240], // Torregorda
  [36.460, -6.220], // Río Arillo boundary
  [36.468, -6.213], // Río Arillo inland (border with San Fernando)
  [36.480, -6.245], // Santibáñez / Bahía
  [36.490, -6.263], // Cortadura bay side
  [36.495, -6.253], // Zona Franca interior
  [36.505, -6.256], // Zona Franca exterior
  [36.512, -6.262], // Puntales
  [36.520, -6.268], // Barriada de la Paz
  [36.527, -6.272], // Astilleros / Navantia Cádiz
  [36.533, -6.278], // Muelle Pesquero
  [36.545, -6.280], // Closing point
];

export function isPointInPolygon(lat, lon, poly = CADIZ_SERVICE_AREA_POLYGON) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = ((yi > lon) !== (yj > lon)) &&
      (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isInCadiz(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || isNaN(lat) || isNaN(lon)) {
    return false;
  }
  return isPointInPolygon(lat, lon, CADIZ_SERVICE_AREA_POLYGON);
}

