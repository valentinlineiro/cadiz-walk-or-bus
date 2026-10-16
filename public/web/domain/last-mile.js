import { WALK_METERS_PER_MINUTE } from './constants.js';
import { walkMinutes } from './walking.js';
/**
 * Computes the last-mile walk duration from alighting stop to destination.
 *
 * Contract:
 * - Exact routed path available with finite duration -> uses exact routed minutes, not degraded.
 * - Distance known but route unavailable (network failure, unroutable) -> falls back to distance / pace, flagged degraded.
 * - Distance unknown or negative -> falls back to 0 minutes, flagged degraded.
 */
export function computeLastMile(lastMileRoute, distanceMeters, walkPaceMetersPerMinute = WALK_METERS_PER_MINUTE) {
    if (lastMileRoute && typeof lastMileRoute.minutes === 'number' && Number.isFinite(lastMileRoute.minutes)) {
        return { lastMileMinutes: lastMileRoute.minutes, lastMileDegraded: false };
    }
    const dist = typeof distanceMeters === 'number' && Number.isFinite(distanceMeters) ? Math.max(0, distanceMeters) : 0;
    const pace = walkPaceMetersPerMinute > 0 ? walkPaceMetersPerMinute : WALK_METERS_PER_MINUTE;
    return {
        lastMileMinutes: walkMinutes(dist, pace),
        lastMileDegraded: true,
    };
}
