import { FindBestJourneysUseCase } from './FindBestJourneysUseCase.js';
/**
 * The compact form of the full decision: same pipeline, same hero, so a chip can never
 * contradict the result screen. No verdict (null) whenever the full decision is not trustworthy.
 */
export class GetQuickVerdictUseCase {
    findBestJourneys;
    constructor(ports) {
        this.findBestJourneys = new FindBestJourneysUseCase(ports);
    }
    async execute(input) {
        const { hero, transitData } = await this.findBestJourneys.execute(input);
        if (!hero || transitData === 'unavailable')
            return null;
        // A silent stop could hold a better bus, and a degraded walk is only a straight-line guess.
        if (hero.mode === 'walk' && (transitData === 'partial' || hero.dataQuality === 'degraded'))
            return null;
        return { kind: hero.mode, totalMinutes: hero.totalMinutes };
    }
}
