import type { TransitDataPort } from '../../application/ports/TransitDataPort.js';
import type { Arrival, LinesTopology, Stop } from '../../domain/models.js';

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
