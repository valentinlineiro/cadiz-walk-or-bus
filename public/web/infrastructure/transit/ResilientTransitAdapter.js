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
    async getArrivals(stopId) {
        try {
            return await withTimeout(this.realtime.getArrivals(stopId), this.timeoutMs);
        }
        catch {
            return this.scheduled.getArrivals(stopId);
        }
    }
}
