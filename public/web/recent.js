const STORAGE_KEY = 'cadiz_recent_destinations';
const MAX_RECENT = 5;

function getStorage(impl) {
  if (impl !== undefined) return impl;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getRecent(storageImpl) {
  const storage = getStorage(storageImpl);
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => item && typeof item.label === 'string' && Number.isFinite(item.lat) && Number.isFinite(item.lon)
    ).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function saveRecent(dest, storageImpl, max = MAX_RECENT) {
  if (!dest || typeof dest.label !== 'string' || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) {
    return getRecent(storageImpl);
  }
  const storage = getStorage(storageImpl);
  const current = getRecent(storageImpl);
  const item = { label: dest.label.trim(), lat: Number(dest.lat), lon: Number(dest.lon) };

  const filtered = current.filter((c) => {
    const sameLabel = c.label.toLowerCase() === item.label.toLowerCase();
    const closeCoords = Math.abs(c.lat - item.lat) < 0.0002 && Math.abs(c.lon - item.lon) < 0.0002;
    return !sameLabel && !closeCoords;
  });

  const updated = [item, ...filtered].slice(0, max);
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // QuotaExceeded or disabled storage - fail silently
    }
  }
  return updated;
}
