import type { GeocodingPort, GeocodingResult } from '../ports/GeocodingPort.js';

export class SearchDestinationsUseCase {
  constructor(private readonly geocoding: GeocodingPort) {}

  async execute(query: string, limit?: number): Promise<GeocodingResult[]> {
    return this.geocoding.search(query, limit);
  }
}
