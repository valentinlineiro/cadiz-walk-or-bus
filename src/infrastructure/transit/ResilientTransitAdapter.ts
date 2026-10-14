import type { TransitDataPort } from '../../application/ports/TransitDataPort.js';
import type { Arrival, ArrivalsResult, LinesTopology, Stop } from '../../domain/models.js';
import { arrivalsResultOf } from '../../application/ports/TransitDataPort.js';

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

export class ResilientTransitAdapter implements TransitDataPort {
  constructor(
    private readonly realtime: TransitDataPort,
    private readonly scheduled: TransitDataPort,
    private readonly timeoutMs = 8000,
  ) {}

  async getStops(): Promise<Stop[]> {
    try {
      return await withTimeout(this.realtime.getStops(), this.timeoutMs);
    } catch {
      return this.scheduled.getStops();
    }
  }

  async getLines(): Promise<LinesTopology | null> {
    try {
      return await withTimeout(this.realtime.getLines(), this.timeoutMs);
    } catch {
      return this.scheduled.getLines();
    }
  }

  /**
   * Same policy as getArrivals, but the answer says where it came from:
   * - live panel answer (even an authoritative empty list) -> `live`
   * - live source failed and the schedule can answer for this stop -> `scheduled` (+ cause)
   * - live source failed and the schedule cannot answer -> `unavailable`
   * Callers must not turn `unavailable` into "no buses".
   */
  async getArrivalsResult(stopId: string | number): Promise<ArrivalsResult> {
    let live: ArrivalsResult;
    try {
      live = typeof this.realtime.getArrivalsResult === 'function'
        ? await withTimeout(this.realtime.getArrivalsResult(stopId), this.timeoutMs)
        : { status: 'live', arrivals: await withTimeout(this.realtime.getArrivals(stopId), this.timeoutMs) };
    } catch {
      live = { status: 'unavailable', cause: 'source_error' };
    }
    if (live.status === 'live') return live;

    const scheduled = await arrivalsResultOf(this.scheduled, stopId);
    if (scheduled.status === 'scheduled') return { ...scheduled, cause: 'source_error' };
    return { status: 'unavailable', cause: live.status === 'unavailable' ? live.cause : 'source_error' };
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
  async getArrivals(stopId: string | number): Promise<Arrival[]> {
    try {
      return await withTimeout(this.realtime.getArrivals(stopId), this.timeoutMs);
    } catch {
      try {
        return await this.scheduled.getArrivals(stopId);
      } catch {
        return [];
      }
    }
  }
}
