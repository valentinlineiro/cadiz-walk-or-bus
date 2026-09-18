export class MunicipalTransitAdapter {
    fetchImpl;
    constructor(fetchImpl = globalThis.fetch) {
        this.fetchImpl = (fetchImpl ?? globalThis.fetch).bind(globalThis);
    }
    async getStops() {
        const r = await this.fetchImpl('/stops');
        if (!r.ok)
            throw new Error(`stops ${r.status}`);
        return r.json();
    }
    async getLines() {
        let r;
        try {
            r = await this.fetchImpl('/lines');
        }
        catch {
            return null;
        }
        if (!r.ok)
            return null;
        try {
            const data = await r.json();
            return (data?.lines ?? null);
        }
        catch {
            return null;
        }
    }
    async getArrivals(stopId) {
        let r;
        try {
            r = await this.fetchImpl(`/api?stop=${encodeURIComponent(String(stopId))}`);
        }
        catch {
            return [];
        }
        if (!r.ok)
            return [];
        try {
            const data = await r.json();
            return (data?.arrivals ?? []);
        }
        catch {
            return [];
        }
    }
}
