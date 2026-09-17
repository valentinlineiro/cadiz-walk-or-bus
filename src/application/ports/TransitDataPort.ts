import type { Arrival, LinesTopology, Stop } from '../../domain/models.js';

export interface TransitDataPort {
  getStops(): Promise<Stop[]>;
  getLines(): Promise<LinesTopology | null>;
  getArrivals(stopId: string | number): Promise<Arrival[]>;
}
