import type { TransitDataPort } from '../../application/ports/TransitDataPort.js';
import { arrivalsResultOf } from '../../application/ports/TransitDataPort.js';
import type { Arrival, ArrivalsResult, LinesTopology, Stop } from '../../domain/models.js';

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('realtime timeout')), timeoutMs);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * Bounds every call to the municipal source. There is no second source: a failure is reported,
 * never replaced by other data. Catalogues throw (the caller can retry); arrivals say
 * `unavailable`, and only a source that actually answered, even with `[]`, is `live`.
 */
export class TimeoutTransitAdapter implements TransitDataPort {
  constructor(
    private readonly realtime: TransitDataPort,
    private readonly timeoutMs = 8000,
  ) {}

  getStops(): Promise<Stop[]> {
    return withTimeout(this.realtime.getStops(), this.timeoutMs);
  }

  getLines(): Promise<LinesTopology | null> {
    return withTimeout(this.realtime.getLines(), this.timeoutMs);
  }

  getArrivals(stopId: string | number): Promise<Arrival[]> {
    return withTimeout(this.realtime.getArrivals(stopId), this.timeoutMs);
  }

  getArrivalsResult(stopId: string | number): Promise<ArrivalsResult> {
    return withTimeout(arrivalsResultOf(this.realtime, stopId), this.timeoutMs).catch(
      (): ArrivalsResult => ({ status: 'unavailable', cause: 'source_error' }),
    );
  }
}
