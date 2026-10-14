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
        const r = await this.fetchImpl('/lines');
        if (!r.ok)
            throw new Error(`lines ${r.status}`);
        const data = await r.json();
        return (data?.lines ?? null);
    }
    async getArrivalsResult(stopId) {
        try {
            return { status: 'live', arrivals: await this.getArrivals(stopId) };
        }
        catch {
            return { status: 'unavailable', cause: 'source_error' };
        }
    }
    async getArrivals(stopId) {
        const r = await this.fetchImpl(`/api?stop=${encodeURIComponent(String(stopId))}`);
        if (!r.ok)
            throw new Error(`arrivals ${r.status}`);
        const data = await r.json();
        if (!data || !Array.isArray(data.arrivals)) {
            throw new Error('malformed arrivals response');
        }
        return data.arrivals.map((arrival) => ({
            ...arrival,
            source: 'realtime',
        }));
    }
}
