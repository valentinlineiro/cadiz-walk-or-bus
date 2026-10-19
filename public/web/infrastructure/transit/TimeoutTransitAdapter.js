import { arrivalsResultOf } from '../../application/ports/TransitDataPort.js';
function withTimeout(operation, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return operation;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('realtime timeout')), timeoutMs);
        operation.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
/**
 * Bounds every call to the municipal source. There is no second source: a failure is reported,
 * never replaced by other data. Catalogues throw (the caller can retry); arrivals say
 * `unavailable`, and only a source that actually answered, even with `[]`, is `live`.
 */
export class TimeoutTransitAdapter {
    realtime;
    timeoutMs;
    constructor(realtime, timeoutMs = 8000) {
        this.realtime = realtime;
        this.timeoutMs = timeoutMs;
    }
    getStops() {
        return withTimeout(this.realtime.getStops(), this.timeoutMs);
    }
    getLines() {
        return withTimeout(this.realtime.getLines(), this.timeoutMs);
    }
    getArrivals(stopId) {
        return withTimeout(this.realtime.getArrivals(stopId), this.timeoutMs);
    }
    getArrivalsResult(stopId) {
        return withTimeout(arrivalsResultOf(this.realtime, stopId), this.timeoutMs).catch(() => ({ status: 'unavailable', cause: 'source_error' }));
    }
}
