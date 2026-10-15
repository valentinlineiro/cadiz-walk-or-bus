import type { Coordinates } from '../../domain/models.js';

export interface GeocodingResult {
  label: string;
  sub: string;
  lat: number;
  lon: number;
}

/**
 * The provider could not be asked or did not give a usable answer. Distinct from an empty
 * result: `[]` means "asked, nothing matches". The message is safe to show; the cause is for logs.
 */
export class GeocodingUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Destination search is unavailable', options);
    this.name = 'GeocodingUnavailableError';
  }
}

export interface GeocodingPort {
  /**
   * Searches for matching destinations bounded to Cádiz.
   * Conserves existing Nominatim query parameters and result normalization.
   * Resolves `[]` when the provider answered and nothing matches; rejects with
   * GeocodingUnavailableError when it could not be asked or answered unusably.
   */
  search(query: string, limit?: number): Promise<GeocodingResult[]>;

  /**
   * Resolves a single query string to geographic coordinates.
   * Returns null if unresolvable or on any failure (never rejects).
   */
  geocode(query: string): Promise<(Coordinates & { name?: string }) | null>;
}
