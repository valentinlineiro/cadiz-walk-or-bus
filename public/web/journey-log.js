import { parseIdentity, isSameIdentity } from './identity.js';
import { classifyDivergence } from './diversity.js';

export { classifyDivergence };

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

function normalizeEntryOnRead(item) {
  if (!item || !item.recommendation) return null;
  let choice = item.choice ?? null;
  const choiceId = typeof choice === 'string' ? choice : (choice && typeof choice === 'object' ? String(choice.identity || '') : '');
  const choiceParts = parseIdentity(choiceId);

  if (typeof choice === 'string') {
    const isWalk = choiceParts?.mode === 'walk';
    choice = {
      identity: choice,
      mode: isWalk ? 'walk' : 'bus',
      busLine: (choiceParts?.mode === 'bus' ? choiceParts.line : null) || (item.recommendation.busLine ?? null),
      boardingStopId: (choiceParts?.mode === 'bus' ? choiceParts.boardingStopId : null) || null,
      alightStopId: (choiceParts?.mode === 'bus' ? choiceParts.alightStopId : null) || null,
      totalMinutes: item.recommendation.totalMinutes ?? 0,
      deltaMinutes: 0,
      divergenceType: 'none',
    };
  } else if (choice && typeof choice === 'object') {
    choice = {
      identity: choiceId,
      mode: choice.mode === 'walk' ? 'walk' : 'bus',
      busLine: choice.busLine != null ? String(choice.busLine) : (choiceParts?.mode === 'bus' ? choiceParts.line || null : null),
      boardingStopId: choice.boardingStopId != null ? String(choice.boardingStopId) : (choiceParts?.mode === 'bus' ? choiceParts.boardingStopId || null : null),
      alightStopId: choice.alightStopId != null ? String(choice.alightStopId) : (choiceParts?.mode === 'bus' ? choiceParts.alightStopId || null : null),
      totalMinutes: Number(choice.totalMinutes) || 0,
      deltaMinutes: Number.isFinite(Number(choice.deltaMinutes)) ? Number(choice.deltaMinutes) : 0,
      divergenceType: choice.divergenceType || 'none',
    };
  }

  const recIdentity = item.recommendation.identity ??
    (item.recommendation.kind === 'walk'
      ? 'walk:direct'
      : (item.recommendation.busLine ? `bus:${item.recommendation.busLine}` : 'bus:unknown'));

  const recParts = parseIdentity(recIdentity);
  const recBoarding = item.recommendation.boardingStopId != null
    ? String(item.recommendation.boardingStopId)
    : (recParts?.mode === 'bus' ? recParts.boardingStopId || null : null);
  const recAlight = item.recommendation.alightStopId != null
    ? String(item.recommendation.alightStopId)
    : (recParts?.mode === 'bus' ? recParts.alightStopId || null : null);

  return {
    ...item,
    recommendation: {
      identity: recIdentity,
      kind: item.recommendation.kind,
      walkMinutes: item.recommendation.walkMinutes ?? null,
      busLine: item.recommendation.busLine ?? (recParts?.mode === 'bus' ? recParts.line || null : null),
      boardingStopId: recBoarding,
      alightStopId: recAlight,
      totalMinutes: item.recommendation.totalMinutes ?? null,
    },
    choice,
  };
}

export function getLog(storageImpl) {
  const storage = getStorage(storageImpl);
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
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
      )
      .map(normalizeEntryOnRead)
      .slice(0, MAX_LOG);
  } catch {
    return [];
  }
}

export function appendEntry(entry, storageImpl, max = MAX_LOG) {
  if (
    !entry ||
    !entry.destination ||
    typeof entry.destination.label !== 'string' ||
    !Number.isFinite(Number(entry.destination.lat)) ||
    !Number.isFinite(Number(entry.destination.lon)) ||
    !entry.recommendation ||
    typeof entry.recommendation.kind !== 'string'
  ) {
    return getLog(storageImpl);
  }

  const storage = getStorage(storageImpl);
  const current = getLog(storageImpl);
  const timestamp = typeof entry.timestamp === 'number' ? entry.timestamp : Date.now();

  let choice = null;
  if (entry.choice && typeof entry.choice === 'object') {
    const choiceId = String(entry.choice.identity || '');
    const parts = parseIdentity(choiceId);
    choice = {
      identity: choiceId,
      mode: entry.choice.mode === 'walk' ? 'walk' : 'bus',
      busLine: entry.choice.busLine != null ? String(entry.choice.busLine) : (parts?.mode === 'bus' ? parts.line || null : null),
      boardingStopId: entry.choice.boardingStopId != null ? String(entry.choice.boardingStopId) : (parts?.mode === 'bus' ? parts.boardingStopId || null : null),
      alightStopId: entry.choice.alightStopId != null ? String(entry.choice.alightStopId) : (parts?.mode === 'bus' ? parts.alightStopId || null : null),
      totalMinutes: Number(entry.choice.totalMinutes) || 0,
      deltaMinutes: Number.isFinite(Number(entry.choice.deltaMinutes)) ? Number(entry.choice.deltaMinutes) : 0,
      divergenceType: entry.choice.divergenceType || 'none',
    };
  } else if (typeof entry.choice === 'string') {
    const parts = parseIdentity(entry.choice);
    const isWalk = parts?.mode === 'walk';
    choice = {
      identity: entry.choice,
      mode: isWalk ? 'walk' : 'bus',
      busLine: (parts?.mode === 'bus' ? parts.line : null) || (entry.recommendation?.busLine ?? null),
      boardingStopId: (parts?.mode === 'bus' ? parts.boardingStopId : null) || null,
      alightStopId: (parts?.mode === 'bus' ? parts.alightStopId : null) || null,
      totalMinutes: entry.recommendation?.totalMinutes ?? 0,
      deltaMinutes: 0,
      divergenceType: 'none',
    };
  }

  const recIdentity = entry.recommendation.identity ??
    (entry.recommendation.kind === 'walk'
      ? 'walk:direct'
      : (entry.recommendation.busLine ? `bus:${entry.recommendation.busLine}` : 'bus:unknown'));

  const recParts = parseIdentity(recIdentity);
  const recBoarding = entry.recommendation.boardingStopId != null
    ? String(entry.recommendation.boardingStopId)
    : (recParts?.mode === 'bus' ? recParts.boardingStopId || null : null);
  const recAlight = entry.recommendation.alightStopId != null
    ? String(entry.recommendation.alightStopId)
    : (recParts?.mode === 'bus' ? recParts.alightStopId || null : null);

  const normalized = {
    id: entry.id || `${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp,
    destination: {
      label: entry.destination.label.trim(),
      lat: Number(entry.destination.lat),
      lon: Number(entry.destination.lon),
    },
    recommendation: {
      identity: recIdentity,
      kind: entry.recommendation.kind,
      walkMinutes: entry.recommendation.walkMinutes ?? null,
      busLine: entry.recommendation.busLine ?? (recParts?.mode === 'bus' ? recParts.line || null : null),
      boardingStopId: recBoarding,
      alightStopId: recAlight,
      totalMinutes: entry.recommendation.totalMinutes ?? null,
    },
    choice,
  };

  // Check if recent entry for same destination exists within DEDUP_WINDOW_MS
  const existingIndex = current.findIndex(
    (item) =>
      sameDestination(item.destination, normalized.destination) &&
      Math.abs(timestamp - item.timestamp) <= DEDUP_WINDOW_MS,
  );

  let updated;
  if (existingIndex !== -1) {
    // Update recommendation, timestamp, and choice of existing item, place at top (LIFO)
    const existing = current[existingIndex];
    const merged = {
      ...existing,
      timestamp: normalized.timestamp,
      recommendation: normalized.recommendation,
      choice: normalized.choice ?? existing.choice ?? null,
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

export function getRecentDestinations(n = 5, storageImpl) {
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

  // Memory v1: sort strictly by recency (most recent evaluation first)
  grouped.sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  return grouped.slice(0, n);
}

// Alias for backwards-compatibility or v2 preparation
export const getTopDestinations = getRecentDestinations;

