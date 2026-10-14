import type { Arrival, ArrivalsResult, LinesTopology, Stop } from '../../domain/models.js';

export interface TransitDataPort {
  getStops(): Promise<Stop[]>;
  getLines(): Promise<LinesTopology | null>;
  getArrivals(stopId: string | number): Promise<Arrival[]>;
  /**
   * Arrivals with an explicit source status. Optional so simple doubles keep working; use
   * `arrivalsResultOf` instead of calling it directly.
   */
  getArrivalsResult?(stopId: string | number): Promise<ArrivalsResult>;
}

/** Normalises any port to an ArrivalsResult: a thrown error is `unavailable`, never `[]`. */
export async function arrivalsResultOf(
  port: TransitDataPort,
  stopId: string | number,
): Promise<ArrivalsResult> {
  try {
    if (typeof port.getArrivalsResult === 'function') return await port.getArrivalsResult(stopId);
    return { status: 'live', arrivals: await port.getArrivals(stopId) };
  } catch {
    return { status: 'unavailable', cause: 'source_error' };
  }
}
