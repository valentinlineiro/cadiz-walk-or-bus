import { WALK_METERS_PER_MINUTE } from './constants.js';

/**
 * Minutes to walk a distance at the urban pace, rounded up: a partial minute is a minute the
 * traveller spends walking. The single owner of distance -> walking minutes for estimates and
 * fallbacks; routed minutes returned by the router are not recomputed with it.
 */
export function walkMinutes(meters: number, pace: number = WALK_METERS_PER_MINUTE): number {
  if (!Number.isFinite(meters) || meters <= 0 || !(pace > 0)) return 0;
  return Math.ceil(meters / pace);
}
