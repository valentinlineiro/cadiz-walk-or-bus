import type { JourneyLogPort } from '../../application/ports/JourneyLogPort.js';
import type { DecisionRecord } from '../../domain/models.js';

export const STORAGE_KEY = 'cadiz_journey_log';
export const DEDUPE_WINDOW_MS = 300000; // 5 minutes
export const DEDUPE_COORD_EPSILON = 0.0002;
export const MAX_ENTRIES = 200;

export function formatRecommendationSub(rec: any): string | null {
  if (!rec) return null;
  const isBus = rec.mode === 'bus' || rec.kind === 'bus';
  const isWalk = rec.mode === 'walk' || rec.kind === 'walk';
  if (!isBus && !isWalk) return null;

  if (isBus) {
    const rawLine = rec.busLine ?? rec.line;
    const lineStr = rawLine ? (String(rawLine).startsWith('L') ? rawLine : `L${rawLine}`) + ' · ' : '';
    const mins = rec.totalMinutes ?? rec.minutes;
    const total = mins != null ? `${mins}′` : '';
    return `última vez: BUS ${lineStr}${total}`.trim();
  }

  if (isWalk) {
    const mins = rec.walkMinutes ?? rec.totalMinutes ?? rec.minutes;
    if (mins != null) {
      return `última vez: ANDAR · ${mins}′`;
    }
    return 'última vez: ANDAR';
  }

  return null;
}

function sameDestination(d1: { lat: number; lon: number }, d2: { lat: number; lon: number }): boolean {
  if (!d1 || !d2) return false;
  return Math.abs(d1.lat - d2.lat) < DEDUPE_COORD_EPSILON && Math.abs(d1.lon - d2.lon) < DEDUPE_COORD_EPSILON;
}

export interface DestinationSummary {
  label: string;
  lat: number;
  lon: number;
  count: number;
  lastTimestamp: number;
  lastRecommendation?: DecisionRecord['recommendation'] | null;
  sub?: string | null;
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

      return parsed
        .filter(
          (item: any) =>
            item &&
            typeof item === 'object' &&
            (item.id == null || typeof item.id === 'string') &&
            typeof item.timestamp === 'number' &&
            item.destination &&
            typeof item.destination.lat === 'number' &&
            typeof item.destination.lon === 'number' &&
            item.recommendation &&
            typeof item.recommendation === 'object',
        )
        .slice(0, MAX_ENTRIES) as DecisionRecord[];
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
        log.splice(existingIdx, 1);
      }
      log.unshift(record);
      if (log.length > MAX_ENTRIES) {
        log.length = MAX_ENTRIES;
      }

      this.storageImpl.setItem(STORAGE_KEY, JSON.stringify(log));
    } catch {
      // Ignore QuotaExceededError or security exceptions silently
    }
  }

  private getGroupedDestinations(): DestinationSummary[] {
    const log = this.getLog();
    const groups: DestinationSummary[] = [];

    for (const entry of log) {
      if (!entry.destination) continue;
      const existing = groups.find((g) => sameDestination(g, entry.destination));
      if (existing) {
        existing.count++;
        if (entry.timestamp > existing.lastTimestamp) {
          existing.lastTimestamp = entry.timestamp;
          existing.label = entry.destination.label ?? existing.label;
          existing.lat = entry.destination.lat;
          existing.lon = entry.destination.lon;
          existing.lastRecommendation = entry.recommendation;
          existing.sub = formatRecommendationSub(entry.recommendation);
        }
      } else {
        groups.push({
          label: entry.destination.label ?? '',
          lat: entry.destination.lat,
          lon: entry.destination.lon,
          count: 1,
          lastTimestamp: entry.timestamp,
          lastRecommendation: entry.recommendation,
          sub: formatRecommendationSub(entry.recommendation),
        });
      }
    }

    return groups;
  }

  getRecentDestinations(n = 5): DestinationSummary[] {
    const groups = this.getGroupedDestinations();
    groups.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    return groups.slice(0, n);
  }

  getTopDestinations(n = 5): DestinationSummary[] {
    const groups = this.getGroupedDestinations();
    groups.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.lastTimestamp - a.lastTimestamp;
    });
    return groups.slice(0, n);
  }
}
