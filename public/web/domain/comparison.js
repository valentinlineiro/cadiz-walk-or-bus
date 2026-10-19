import { EQUIVALENT_WITHIN_MINUTES } from './constants.js';
/**
 * How walking compares with the bus, from door-to-door totals. The only owner of "equivalent".
 * Null when either time is not a finite number: there is nothing honest to compare.
 */
export function compareWalkAndBus(input) {
    if (!Number.isFinite(input.walkMinutes) || !Number.isFinite(input.busMinutes))
        return null;
    const difference = Math.round(input.walkMinutes - input.busMinutes);
    const minutes = Math.abs(difference);
    if (minutes <= EQUIVALENT_WITHIN_MINUTES)
        return { verdict: 'equivalent', minutes };
    return { verdict: difference > 0 ? 'bus-faster' : 'walk-faster', minutes };
}
