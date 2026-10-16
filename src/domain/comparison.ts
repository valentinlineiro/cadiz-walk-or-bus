import { EQUIVALENT_WITHIN_MINUTES } from './constants.js';

export type WalkBusVerdict = 'equivalent' | 'bus-faster' | 'walk-faster';

export interface WalkBusComparison {
  verdict: WalkBusVerdict;
  /** Whole minutes by which the faster option wins (the rounded absolute difference). */
  minutes: number;
}

/** How walking compares with the bus, from door-to-door totals. The only owner of "equivalent". */
export function compareWalkAndBus(input: { walkMinutes: number; busMinutes: number }): WalkBusComparison {
  const difference = Math.round(input.walkMinutes - input.busMinutes);
  const minutes = Math.abs(difference);
  if (minutes <= EQUIVALENT_WITHIN_MINUTES) return { verdict: 'equivalent', minutes };
  return { verdict: difference > 0 ? 'bus-faster' : 'walk-faster', minutes };
}
