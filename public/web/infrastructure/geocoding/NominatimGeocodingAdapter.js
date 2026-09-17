export const CADIZ_VIEWBOX = '-6.35,36.60,-6.20,36.40';
export class NominatimGeocodingAdapter {
    fetchImpl;
    constructor(fetchImpl = globalThis.fetch) {
        this.fetchImpl = fetchImpl;
    }
    async search(query, limit = 5) {
        if (!query || query.trim().length < 2)
            return [];
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
        return hits.map((hit) => {
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
        });
    }
    async geocode(query) {
        if (!query || !query.trim())
            return null;
        const hits = await this.search(query, 1);
        return hits.length > 0 ? { lat: hits[0].lat, lon: hits[0].lon, name: hits[0].label } : null;
    }
}
