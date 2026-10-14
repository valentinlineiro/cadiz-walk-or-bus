function withTimeout(operation, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return operation;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('realtime timeout')), timeoutMs);
        operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
export class ResilientTransitAdapter {
    realtime;
    scheduled;
    timeoutMs;
    constructor(realtime, scheduled, timeoutMs = 8000) {
        this.realtime = realtime;
        this.scheduled = scheduled;
        this.timeoutMs = timeoutMs;
    }
    async getStops() {
        try {
            return await withTimeout(this.realtime.getStops(), this.timeoutMs);
        }
        catch {
            return this.scheduled.getStops();
        }
    }
    async getLines() {
        try {
            return await withTimeout(this.realtime.getLines(), this.timeoutMs);
        }
        catch {
            return this.scheduled.getLines();
        }
    }
    /**
     * Fetches arrivals with authoritative Policy A semantics:
     * - 200 OK with arrivals -> returns live arrivals.
     * - 200 OK with empty array [] -> authoritative; returns [] without scheduled fallback.
     * - Timeout / Network error / HTTP 5xx -> falls back to scheduled GTFS.
     *
     * Isolation guarantee:
     * If a realtime request times out, the fallback to scheduled is immediate. The residual
     * realtime promise completes in isolation without mutating shared state or overwriting
     * decisions in flight. Upstream municipal network calls are also bounded server-side
     * by the Cloudflare Worker at 4 seconds.
     */
    async getArrivals(stopId) {
        try {
            return await withTimeout(this.realtime.getArrivals(stopId), this.timeoutMs);
        }
        catch {
            try {
                return await this.scheduled.getArrivals(stopId);
            }
            catch {
                return [];
            }
        }
    }
}
