const STORAGE_KEY = 'cadiz_journey_log';
export const MAX_LOG = 200;
export const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const SAME_SPOT_DEG = 0.0002;

function getStorage(impl) {
  if (impl !== undefined) return impl;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function sameDestination(a, b) {
  if (!a || !b) return false;
  return (
    Math.abs(Number(a.lat) - Number(b.lat)) < SAME_SPOT_DEG &&
    Math.abs(Number(a.lon) - Number(b.lon)) < SAME_SPOT_DEG
  );
}

export function formatRecommendationSub(rec) {
  if (!rec || typeof rec.kind !== 'string') return null;
  if (rec.kind === 'bus') {
    const lineStr = rec.busLine
      ? `${String(rec.busLine).startsWith('L') ? rec.busLine : `L${rec.busLine}`} · `
      : '';
    const total = rec.totalMinutes != null ? `${rec.totalMinutes}′` : '';
    return `última vez: BUS ${lineStr}${total}`.trim();
  }
  if (rec.kind === 'walk') {
    const mins = rec.walkMinutes != null ? `${rec.walkMinutes}′` : '';
    return `última vez: ANDAR · ${mins}`.trim();
  }
  return null;
}

export function getLog(storageImpl) {
  const storage = getStorage(storageImpl);
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.timestamp === 'number' &&
        item.destination &&
        typeof item.destination.label === 'string' &&
        Number.isFinite(item.destination.lat) &&
        Number.isFinite(item.destination.lon) &&
        item.recommendation &&
        typeof item.recommendation.kind === 'string',
    ).slice(0, MAX_LOG);
  } catch {
    return [];
  }
}

export function appendEntry(entry, storageImpl, max = MAX_LOG) {
  if (
    !entry ||
    !entry.destination ||
    typeof entry.destination.label !== 'string' ||
    !Number.isFinite(entry.destination.lat) ||
    !Number.isFinite(entry.destination.lon) ||
    !entry.recommendation ||
    typeof entry.recommendation.kind !== 'string'
  ) {
    return getLog(storageImpl);
  }

  const storage = getStorage(storageImpl);
  const current = getLog(storageImpl);
  const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();
  const normalized = {
    id: entry.id || `${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp,
    destination: {
      label: entry.destination.label.trim(),
      lat: Number(entry.destination.lat),
      lon: Number(entry.destination.lon),
    },
    recommendation: {
      kind: entry.recommendation.kind,
      walkMinutes: entry.recommendation.walkMinutes ?? null,
      busLine: entry.recommendation.busLine ?? null,
      totalMinutes: entry.recommendation.totalMinutes ?? null,
    },
    choice: null,
  };

  // Check if recent entry for same destination exists within DEDUP_WINDOW_MS
  const existingIndex = current.findIndex(
    (item) =>
      sameDestination(item.destination, normalized.destination) &&
      Math.abs(timestamp - item.timestamp) <= DEDUP_WINDOW_MS,
  );

  let updated;
  if (existingIndex !== -1) {
    // Update recommendation and timestamp of existing item, place at top (LIFO)
    const existing = current[existingIndex];
    const merged = {
      ...existing,
      timestamp: normalized.timestamp,
      recommendation: normalized.recommendation,
    };
    updated = [merged, ...current.filter((_, idx) => idx !== existingIndex)].slice(0, max);
  } else {
    updated = [normalized, ...current].slice(0, max);
  }

  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // QuotaExceeded or disabled storage - survive silently
    }
  }
  return updated;
}

export function getTopDestinations(n = 5, storageImpl) {
  const entries = getLog(storageImpl);
  if (entries.length === 0) return [];

  const grouped = [];
  for (const entry of entries) {
    const existing = grouped.find((g) => sameDestination(g, entry.destination));
    if (existing) {
      existing.count += 1;
      // Since getLog returns LIFO, the first seen is already the most recent
    } else {
      grouped.push({
        label: entry.destination.label,
        lat: entry.destination.lat,
        lon: entry.destination.lon,
        count: 1,
        lastTimestamp: entry.timestamp,
        lastRecommendation: entry.recommendation,
        sub: formatRecommendationSub(entry.recommendation),
      });
    }
  }

  grouped.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count; // primary: frequency desc
    }
    return b.lastTimestamp - a.lastTimestamp; // tie-breaker: recency desc
  });

  return grouped.slice(0, n);
}
