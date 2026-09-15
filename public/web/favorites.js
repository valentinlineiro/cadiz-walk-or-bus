// Manually pinned destinations ("Home", "Work", ...) — distinct from
// recent.js's auto-tracked search history, which reorders/evicts on every
// search. Mirrors recent.js's storage shape deliberately.
const STORAGE_KEY = 'cadiz_favorite_destinations';
const MAX_FAVORITES = 8;
const SAME_SPOT_DEG = 0.0002;

function getStorage(impl) {
  if (impl !== undefined) return impl;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function sameSpot(a, b) {
  return Math.abs(a.lat - b.lat) < SAME_SPOT_DEG && Math.abs(a.lon - b.lon) < SAME_SPOT_DEG;
}

export function getFavorites(storageImpl) {
  const storage = getStorage(storageImpl);
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => item && typeof item.label === 'string' && Number.isFinite(item.lat) && Number.isFinite(item.lon)
    ).slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function isFavorite(dest, storageImpl) {
  if (!dest || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) return false;
  return getFavorites(storageImpl).some((f) => sameSpot(f, dest));
}

export function addFavorite(dest, storageImpl) {
  if (!dest || typeof dest.label !== 'string' || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) {
    return getFavorites(storageImpl);
  }
  const storage = getStorage(storageImpl);
  const item = { label: dest.label.trim(), lat: Number(dest.lat), lon: Number(dest.lon) };
  const updated = [item, ...getFavorites(storageImpl).filter((c) => !sameSpot(c, item))].slice(0, MAX_FAVORITES);
  if (storage) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
  }
  return updated;
}

export function removeFavorite(dest, storageImpl) {
  const storage = getStorage(storageImpl);
  const updated = getFavorites(storageImpl).filter((c) => !sameSpot(c, dest));
  if (storage) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
  }
  return updated;
}
