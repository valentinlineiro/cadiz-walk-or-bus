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

export function classifyDivergence(choice, recommendation) {
  if (!choice || !recommendation) return 'none';
  const choiceId = choice.identity || '';
  const recId = recommendation.identity || '';
  if (choiceId && recId && choiceId === recId) return 'none';

  const choiceMode = choice.mode || (choiceId.startsWith('walk') ? 'walk' : choiceId.startsWith('bus') ? 'bus' : null);
  const recMode = recommendation.kind || recommendation.mode || (recId.startsWith('walk') ? 'walk' : recId.startsWith('bus') ? 'bus' : null);

  if (choiceMode && recMode && choiceMode !== recMode) {
    return 'mode';
  }

  if (choiceMode === 'bus' && recMode === 'bus') {
    const choiceParts = choiceId.startsWith('bus:') ? choiceId.split(':') : [];
    const recParts = recId.startsWith('bus:') ? recId.split(':') : [];

    const choiceLine = choice.busLine != null ? String(choice.busLine) : (choiceParts[1] || null);
    const recLine = recommendation.busLine != null ? String(recommendation.busLine) : (recParts[1] || null);

    if (choiceLine && recLine && choiceLine !== recLine) {
      return 'line';
    }

    const choiceBoard = choice.boardingStopId != null ? String(choice.boardingStopId) : (choiceParts[2] || null);
    const recBoard = recommendation.boardingStopId != null ? String(recommendation.boardingStopId) : (recParts[2] || null);
    const choiceAlight = choice.alightStopId != null ? String(choice.alightStopId) : (choiceParts[3] || null);
    const recAlight = recommendation.alightStopId != null ? String(recommendation.alightStopId) : (recParts[3] || null);

    if ((choiceBoard && recBoard && choiceBoard !== recBoard) || (choiceAlight && recAlight && choiceAlight !== recAlight)) {
      return 'access';
    }
  }

  return 'none';
}

function normalizeEntryOnRead(item) {
  if (!item || !item.recommendation) return null;
  let choice = item.choice ?? null;
  const choiceId = typeof choice === 'string' ? choice : (choice && typeof choice === 'object' ? String(choice.identity || '') : '');
  const choiceParts = choiceId.startsWith('bus:') ? choiceId.split(':') : [];

  if (typeof choice === 'string') {
    const isWalk = choice.startsWith('walk');
    choice = {
      identity: choice,
      mode: isWalk ? 'walk' : 'bus',
      busLine: choiceParts[1] || (item.recommendation.busLine ?? null),
      boardingStopId: choiceParts[2] || null,
      alightStopId: choiceParts[3] || null,
      totalMinutes: item.recommendation.totalMinutes ?? 0,
      deltaMinutes: 0,
      divergenceType: 'none',
    };
  } else if (choice && typeof choice === 'object') {
    choice = {
      identity: choiceId,
      mode: choice.mode === 'walk' ? 'walk' : 'bus',
      busLine: choice.busLine != null ? String(choice.busLine) : (choiceParts[1] || null),
      boardingStopId: choice.boardingStopId != null ? String(choice.boardingStopId) : (choiceParts[2] || null),
      alightStopId: choice.alightStopId != null ? String(choice.alightStopId) : (choiceParts[3] || null),
      totalMinutes: Number(choice.totalMinutes) || 0,
      deltaMinutes: Number(choice.deltaMinutes) || 0,
      divergenceType: choice.divergenceType || 'none',
    };
  }

  const recIdentity = item.recommendation.identity ??
    (item.recommendation.kind === 'walk'
      ? 'walk:direct'
      : (item.recommendation.busLine ? `bus:${item.recommendation.busLine}` : 'bus:unknown'));

  const recParts = recIdentity.startsWith('bus:') ? recIdentity.split(':') : [];
  const recBoarding = item.recommendation.boardingStopId != null
    ? String(item.recommendation.boardingStopId)
    : (recParts[2] || null);
  const recAlight = item.recommendation.alightStopId != null
    ? String(item.recommendation.alightStopId)
    : (recParts[3] || null);

  return {
    ...item,
    recommendation: {
      identity: recIdentity,
      kind: item.recommendation.kind,
      walkMinutes: item.recommendation.walkMinutes ?? null,
      busLine: item.recommendation.busLine ?? (recParts[1] || null),
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
    const parts = choiceId.startsWith('bus:') ? choiceId.split(':') : [];
    choice = {
      identity: choiceId,
      mode: entry.choice.mode === 'walk' ? 'walk' : 'bus',
      busLine: entry.choice.busLine != null ? String(entry.choice.busLine) : (parts[1] || null),
      boardingStopId: entry.choice.boardingStopId != null ? String(entry.choice.boardingStopId) : (parts[2] || null),
      alightStopId: entry.choice.alightStopId != null ? String(entry.choice.alightStopId) : (parts[3] || null),
      totalMinutes: Number(entry.choice.totalMinutes) || 0,
      deltaMinutes: Number(entry.choice.deltaMinutes) || 0,
      divergenceType: entry.choice.divergenceType || 'none',
    };
  } else if (typeof entry.choice === 'string') {
    const isWalk = entry.choice.startsWith('walk');
    const parts = entry.choice.startsWith('bus:') ? entry.choice.split(':') : [];
    choice = {
      identity: entry.choice,
      mode: isWalk ? 'walk' : 'bus',
      busLine: parts[1] || (entry.recommendation?.busLine ?? null),
      boardingStopId: parts[2] || null,
      alightStopId: parts[3] || null,
      totalMinutes: entry.recommendation?.totalMinutes ?? 0,
      deltaMinutes: 0,
      divergenceType: 'none',
    };
  }

  const recIdentity = entry.recommendation.identity ??
    (entry.recommendation.kind === 'walk'
      ? 'walk:direct'
      : (entry.recommendation.busLine ? `bus:${entry.recommendation.busLine}` : 'bus:unknown'));

  const recParts = recIdentity.startsWith('bus:') ? recIdentity.split(':') : [];
  const recBoarding = entry.recommendation.boardingStopId != null
    ? String(entry.recommendation.boardingStopId)
    : (recParts[2] || null);
  const recAlight = entry.recommendation.alightStopId != null
    ? String(entry.recommendation.alightStopId)
    : (recParts[3] || null);

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
      busLine: entry.recommendation.busLine ?? (recParts[1] || null),
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

