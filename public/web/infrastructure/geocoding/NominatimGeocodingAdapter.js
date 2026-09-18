import { isPointInCadiz } from '../../domain/topology.js';
export const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';
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
function normalizeSearchText(str) {
    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ');
}
export class NominatimGeocodingAdapter {
    fetchImpl;
    constructor(fetchImpl = globalThis.fetch) {
        this.fetchImpl = (fetchImpl ?? globalThis.fetch).bind(globalThis);
    }
    async search(query, limit = 5) {
        if (!query || query.trim().length < 2)
            return [];
        const normQuery = normalizeSearchText(query);
        const hasStreetPrefix = STREET_PREFIX_REGEX.test(query.trim());
        // Reject queries that are bare external cities/territories without an explicit street/poi prefix
        if (!hasStreetPrefix && EXTERNAL_REGIONS.has(normQuery)) {
            return [];
        }
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${limit}&viewbox=${CADIZ_VIEWBOX}&bounded=1&q=${encodeURIComponent(query)}`;
        let r;
        try {
            r = await this.fetchImpl(url);
        }
        catch {
            return [];
        }
        if (!r.ok)
            return [];
        let hits;
        try {
            hits = await r.json();
        }
        catch {
            return [];
        }
        if (!Array.isArray(hits))
            return [];
        return hits
            .filter((hit) => {
            const lat = Number(hit.lat);
            const lon = Number(hit.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon))
                return false;
            return isPointInCadiz(lat, lon);
        })
            .map((hit) => {
            const displayName = String(hit.display_name ?? '');
            const main = hit.name || displayName.split(',')[0].trim();
            const parts = displayName.split(',').map((p) => p.trim());
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
    async geocode(query) {
        if (!query || !query.trim())
            return null;
        const hits = await this.search(query, 1);
        return hits.length > 0 ? { lat: hits[0].lat, lon: hits[0].lon, name: hits[0].label } : null;
    }
}
