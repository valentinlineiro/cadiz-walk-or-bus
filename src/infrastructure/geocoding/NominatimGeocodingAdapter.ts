import type { GeocodingPort, GeocodingResult } from '../../application/ports/GeocodingPort.js';
import type { Coordinates } from '../../domain/models.js';
import { isPointInCadiz } from '../../domain/topology.js';

export const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';

interface NominatimHit {
  name?: string;
  display_name?: string;
  lat: string | number;
  lon: string | number;
}

const EXTERNAL_REGIONS = new Set([
  'madrid',
  'barcelona',
  'sevilla',
  'paris',
  'valencia',
  'malaga',
  'granada',
  'cordoba',
  'bilbao',
  'zaragoza',
  'toledo',
  'londres',
  'london',
  'roma',
  'rome',
  'san fernando',
  'puerto real',
  'el puerto de santa maria',
  'el puerto',
  'chiclana',
  'chiclana de la frontera',
  'jerez',
  'jerez de la frontera',
  'rota',
]);

const STREET_PREFIX_REGEX = /^(calle|c\/|cl|plaza|plza|pza|avda|avenida|av|paseo|pº|glorieta|gta|parque|alameda|jardin|hotel|barrio|playa|muelle|dique|baluarte|castillo|mercado|teatro|hospital)\b/i;

function normalizeSearchText(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ');
}

export class NominatimGeocodingAdapter implements GeocodingPort {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = (fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  async search(query: string, limit: number = 5): Promise<GeocodingResult[]> {
    if (!query || query.trim().length < 2) return [];

    const normQuery = normalizeSearchText(query);
    const hasStreetPrefix = STREET_PREFIX_REGEX.test(query.trim());
    // Reject queries that are bare external cities/territories without an explicit street/poi prefix
    if (!hasStreetPrefix && EXTERNAL_REGIONS.has(normQuery)) {
      return [];
    }

    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`;
    let r: Response;
    try {
      r = await this.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      return [];
    }
    if (!r.ok) return [];

    let hits: NominatimHit[];
    try {
      hits = await r.json();
    } catch {
      return [];
    }

    if (!Array.isArray(hits)) return [];
    return hits
      .filter((hit) => {
        const lat = Number(hit.lat);
        const lon = Number(hit.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
        return isPointInCadiz(lat, lon);
      })
      .map((hit) => {
        const displayName = String(hit.display_name ?? '');
        const main = hit.name || displayName.split(',')[0].trim();
        const parts = displayName.split(',').map((p: string) => p.trim());
        const sub = parts.length > 1 ? parts.slice(1, 3).join(', ') : '';
        return {
          label: String(main),
          sub,
          lat: Number(hit.lat),
          lon: Number(hit.lon),
        };
      })
      .slice(0, limit);
  }

  async geocode(query: string): Promise<(Coordinates & { name?: string }) | null> {
    if (!query || !query.trim()) return null;

    const hits = await this.search(query, 1);
    return hits.length > 0 ? { lat: hits[0].lat, lon: hits[0].lon, name: hits[0].label } : null;
  }
}
