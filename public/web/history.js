import { clearRecent, purgeRecent } from './recent.js';

// The automatically saved history: recents and the journey log. Favourites are the user's own
// choice and are deliberately not part of it.

export function clearHistory({ journeyLog, storage } = {}) {
  clearRecent(storage);
  journeyLog.clear();
}

export function purgeExpiredHistory({ journeyLog, storage, now } = {}) {
  purgeRecent(storage, now);
  journeyLog.purgeExpired();
}
