import type { Coordinates } from '../../domain/models.js';

export interface GeocodingResult {
  label: string;
  sub: string;
  lat: number;
  lon: number;
}

export interface GeocodingPort {
  /**
   * Searches for matching destinations bounded to Cádiz.
   * Conserves existing Nominatim query parameters and result normalization.
   */
  search(query: string, limit?: number): Promise<GeocodingResult[]>;

  /**
   * Resolves a single query string to geographic coordinates.
   * Returns null if unresolvable or on network error.
   */
  geocode(query: string): Promise<(Coordinates & { name?: string }) | null>;
}
