import { WALK_METERS_PER_MINUTE } from './constants.js';
/**
 * Minutes to walk a distance at the urban pace, rounded up: a partial minute is a minute the
 * traveller spends walking. The single owner of distance -> walking minutes for estimates and
 * fallbacks; routed minutes returned by the router are not recomputed with it.
 */
export function walkMinutes(meters, pace = WALK_METERS_PER_MINUTE) {
    if (!Number.isFinite(meters) || meters <= 0 || !Number.isFinite(pace) || pace <= 0)
        return 0;
    return Math.ceil(meters / pace);
}
