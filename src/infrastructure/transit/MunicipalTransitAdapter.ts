import type { TransitDataPort } from '../../application/ports/TransitDataPort.js';
import type { Arrival, LinesTopology, Stop, ArrivalsResult } from '../../domain/models.js';

export class MunicipalTransitAdapter implements TransitDataPort {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch) {
    this.fetchImpl = (fetchImpl ?? globalThis.fetch).bind(globalThis);
  }

  async getStops(): Promise<Stop[]> {
    const r = await this.fetchImpl('/stops');
    if (!r.ok) throw new Error(`stops ${r.status}`);
    return r.json();
  }

  async getLines(): Promise<LinesTopology | null> {
    const r = await this.fetchImpl('/lines');
    if (!r.ok) throw new Error(`lines ${r.status}`);
    const data = await r.json();
    return (data?.lines ?? null) as LinesTopology | null;
  }

  async getArrivalsResult(stopId: string | number): Promise<ArrivalsResult> {
    try {
      return { status: 'live', arrivals: await this.getArrivals(stopId) };
    } catch {
      return { status: 'unavailable', cause: 'source_error' };
    }
  }

  async getArrivals(stopId: string | number): Promise<Arrival[]> {
    const r = await this.fetchImpl(`/api?stop=${encodeURIComponent(String(stopId))}`);
    if (!r.ok) throw new Error(`arrivals ${r.status}`);
    const data = await r.json();
    if (!data || !Array.isArray(data.arrivals)) {
      throw new Error('malformed arrivals response');
    }
    return (data.arrivals as Omit<Arrival, 'source'>[]).map((arrival) => ({
      ...arrival,
      source: 'realtime' as const,
    }));
  }
}
