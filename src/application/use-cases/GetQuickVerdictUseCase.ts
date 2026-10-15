import type { RoutingPort } from '../ports/RoutingPort.js';
import type { TransitDataPort } from '../ports/TransitDataPort.js';
import type { Coordinates } from '../../domain/models.js';
import { FindBestJourneysUseCase } from './FindBestJourneysUseCase.js';

export interface GetQuickVerdictInput {
  origin: Coordinates;
  destination: Coordinates & { label?: string };
}

export interface QuickVerdict {
  kind: 'walk' | 'bus';
  totalMinutes: number;
}

/**
 * The compact form of the full decision: same pipeline, same hero, so a chip can never
 * contradict the result screen. No verdict (null) whenever the full decision is not trustworthy.
 */
export class GetQuickVerdictUseCase {
  private readonly findBestJourneys: FindBestJourneysUseCase;

  constructor(ports: { routing: RoutingPort; transit: TransitDataPort }) {
    this.findBestJourneys = new FindBestJourneysUseCase(ports);
  }

  async execute(input: GetQuickVerdictInput): Promise<QuickVerdict | null> {
    const { hero, transitData } = await this.findBestJourneys.execute({ ...input, withBusGeometry: false });
    if (!hero || transitData === 'unavailable') return null;
    // A silent stop could hold a better bus, and a degraded walk is only a straight-line guess.
    if (hero.mode === 'walk' && (transitData === 'partial' || hero.dataQuality === 'degraded')) return null;
    return { kind: hero.mode, totalMinutes: hero.totalMinutes };
  }
}
