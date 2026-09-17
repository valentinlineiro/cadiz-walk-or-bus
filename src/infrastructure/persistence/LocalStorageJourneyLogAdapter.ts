import type { JourneyLogPort } from '../../application/ports/JourneyLogPort.js';
import type { DecisionRecord } from '../../domain/models.js';

export const STORAGE_KEY = 'cadiz_journey_log';
export const DEDUPE_WINDOW_MS = 300000; // 5 minutes
export const DEDUPE_COORD_EPSILON = 0.0002;
export const MAX_ENTRIES = 200;

function sameDestination(d1: { lat: number; lon: number }, d2: { lat: number; lon: number }): boolean {
  if (!d1 || !d2) return false;
  return Math.abs(d1.lat - d2.lat) < DEDUPE_COORD_EPSILON && Math.abs(d1.lon - d2.lon) < DEDUPE_COORD_EPSILON;
}

export class LocalStorageJourneyLogAdapter implements JourneyLogPort {
  constructor(
    private readonly storageImpl: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null,
  ) {}

  getLog(): DecisionRecord[] {
    if (!this.storageImpl) return [];
    try {
      const raw = this.storageImpl.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (item) => item && typeof item === 'object' && item.id && item.timestamp && item.destination && item.recommendation,
      ) as DecisionRecord[];
    } catch {
      return [];
    }
  }

  append(record: DecisionRecord): void {
    if (!this.storageImpl || !record || !record.destination || !record.recommendation) {
      return;
    }

    try {
      const log = this.getLog();
      const existingIdx = log.findIndex(
        (entry) =>
          sameDestination(entry.destination, record.destination) &&
          Math.abs(record.timestamp - entry.timestamp) <= DEDUPE_WINDOW_MS,
      );

      if (existingIdx !== -1) {
        log[existingIdx] = record;
      } else {
        log.unshift(record);
        if (log.length > MAX_ENTRIES) {
          log.length = MAX_ENTRIES;
        }
      }

      this.storageImpl.setItem(STORAGE_KEY, JSON.stringify(log));
    } catch {
      // Ignore QuotaExceededError or security exceptions silently
    }
  }

  getRecentDestinations(n = 5): Array<DecisionRecord['destination'] & { lastTimestamp: number }> {
    const log = this.getLog();
    const result: Array<DecisionRecord['destination'] & { lastTimestamp: number }> = [];

    for (const entry of log) {
      if (!entry.destination) continue;
      const alreadyIn = result.some((r) => sameDestination(r, entry.destination));
      if (!alreadyIn) {
        result.push({
          ...entry.destination,
          lastTimestamp: entry.timestamp,
        });
        if (result.length >= n) break;
      }
    }

    return result;
  }

  getTopDestinations(n = 5): Array<DecisionRecord['destination'] & { count: number; lastTimestamp: number }> {
    const log = this.getLog();
    const groups: Array<{
      destination: DecisionRecord['destination'];
      count: number;
      lastTimestamp: number;
    }> = [];

    for (const entry of log) {
      if (!entry.destination) continue;
      const existing = groups.find((g) => sameDestination(g.destination, entry.destination));
      if (existing) {
        existing.count++;
        if (entry.timestamp > existing.lastTimestamp) {
          existing.lastTimestamp = entry.timestamp;
          existing.destination = entry.destination;
        }
      } else {
        groups.push({
          destination: entry.destination,
          count: 1,
          lastTimestamp: entry.timestamp,
        });
      }
    }

    groups.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastTimestamp - a.lastTimestamp;
    });

    return groups.slice(0, n).map((g) => ({
      ...g.destination,
      count: g.count,
      lastTimestamp: g.lastTimestamp,
    }));
  }
}
