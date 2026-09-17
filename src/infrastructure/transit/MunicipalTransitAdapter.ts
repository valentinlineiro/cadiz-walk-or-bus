import type { TransitDataPort } from '../../application/ports/TransitDataPort.js';
import type { Arrival, LinesTopology, Stop } from '../../domain/models.js';

export class MunicipalTransitAdapter implements TransitDataPort {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  async getStops(): Promise<Stop[]> {
    const r = await this.fetchImpl('/stops');
    if (!r.ok) throw new Error(`stops ${r.status}`);
    return r.json();
  }

  async getLines(): Promise<LinesTopology | null> {
    let r: Response;
    try {
      r = await this.fetchImpl('/lines');
    } catch {
      return null;
    }
    if (!r.ok) return null;
    try {
      const data = await r.json();
      return (data?.lines ?? null) as LinesTopology | null;
    } catch {
      return null;
    }
  }

  async getArrivals(stopId: string | number): Promise<Arrival[]> {
    let r: Response;
    try {
      r = await this.fetchImpl(`/api?stop=${encodeURIComponent(String(stopId))}`);
    } catch {
      return [];
    }
    if (!r.ok) return [];
    try {
      const data = await r.json();
      return (data?.arrivals ?? []) as Arrival[];
    } catch {
      return [];
    }
  }
}
