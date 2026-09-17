import { DEFAULT_PLANNING_POLICY, DEFAULT_DIVERSITY_THRESHOLDS, } from './constants.js';
import { isSameIdentity, parseIdentity } from './identity.js';
/**
 * Determines whether a candidate option is structurally diverse from a reference journey (Hero or alternative).
 *
 * Rules:
 * 1. Modal diversity: WALK vs BUS -> always diverse.
 * 2. Line diversity: BUS L1 vs BUS L2 -> diverse.
 * 3. Access diversity (same line): boarding access walk delta >= threshold OR alighting distance delta >= threshold -> diverse.
 */
export function isStructurallyDiverse(candidate, hero, thresholds = DEFAULT_DIVERSITY_THRESHOLDS) {
    if (!candidate || !hero)
        return false;
    if (!candidate.identity || !hero.identity || isSameIdentity(candidate.identity, hero.identity))
        return false;
    // 1. Modal diversity
    if (candidate.mode !== hero.mode) {
        return true;
    }
    // 2. Line diversity (for bus)
    if (candidate.mode === 'bus' && hero.mode === 'bus') {
        const candParts = parseIdentity(candidate.identity);
        const heroParts = parseIdentity(hero.identity);
        const candLine = candidate.metadata?.line ?? (candParts.mode === 'bus' ? candParts.line : null);
        const heroLine = hero.metadata?.line ?? (heroParts.mode === 'bus' ? heroParts.line : null);
        if (candLine && heroLine && candLine !== heroLine) {
            return true;
        }
        // 3. Access diversity (same line)
        const accessWalkThreshold = thresholds?.accessWalkMinutes ?? 3;
        const candWalk = candidate.exactJourney?.walkToStopRoute?.minutes ?? candidate.exactJourney?.walkToStopMinutes ?? candidate.estimate?.walkToStopMinutes ?? 0;
        const heroWalk = hero.exactJourney?.walkToStopRoute?.minutes ?? hero.exactJourney?.walkToStopMinutes ?? hero.estimate?.walkToStopMinutes ?? 0;
        if (Math.abs(candWalk - heroWalk) >= accessWalkThreshold) {
            return true;
        }
        const alightDistThreshold = thresholds?.alightDistanceMeters ?? 250;
        const candAlightMeters = candidate.metadata?.alightDistanceMeters ?? 0;
        const heroAlightMeters = hero.metadata?.alightDistanceMeters ?? 0;
        if (Math.abs(candAlightMeters - heroAlightMeters) >= alightDistThreshold) {
            return true;
        }
        return false;
    }
    return false;
}
/**
 * Filters and admits alternative candidates against a reference Hero and previously admitted alternatives.
 */
export function filterDiverseAlternatives(candidates, hero, policy = DEFAULT_PLANNING_POLICY) {
    if (!hero || !Array.isArray(candidates))
        return [];
    const maxDelta = policy.similarityMaxDeltaMinutes ?? 5;
    const maxAlts = policy.maxAlternatives ?? 2;
    const maxCandidates = policy.maxCandidates ?? 3;
    const allowedAlternatives = Math.min(maxAlts, Math.max(0, maxCandidates - 1));
    if (allowedAlternatives <= 0)
        return [];
    const admitted = [];
    for (const cand of candidates) {
        if (admitted.length >= allowedAlternatives)
            break;
        if (!cand || !cand.identity || cand.identity === hero.identity)
            continue;
        if (typeof cand.estimatedMinutes === 'number' && typeof hero.estimatedMinutes === 'number') {
            if (cand.estimatedMinutes - hero.estimatedMinutes > maxDelta)
                continue;
        }
        // Must be structurally diverse from the Hero
        if (!isStructurallyDiverse(cand, hero))
            continue;
        // Must also be structurally diverse from any already admitted alternative
        if (admitted.some((alt) => !isStructurallyDiverse(cand, alt)))
            continue;
        admitted.push(cand);
    }
    return admitted;
}
/**
 * Pure classifier of divergence between user choice and system recommendation.
 * Returns 'none', 'mode', 'line', or 'access'.
 */
export function classifyDivergence(choice, recommendation) {
    if (!choice || !recommendation)
        return 'none';
    const choiceId = choice.identity || '';
    const recId = recommendation.identity || '';
    if (choiceId && recId && isSameIdentity(choiceId, recId))
        return 'none';
    const choiceParts = parseIdentity(choiceId);
    const recParts = parseIdentity(recId);
    const choiceMode = choice.mode || (choiceParts.mode !== 'unknown' ? choiceParts.mode : null);
    const recMode = recommendation.kind || recommendation.mode || (recParts.mode !== 'unknown' ? recParts.mode : null);
    if (choiceMode && recMode && choiceMode !== recMode) {
        return 'mode';
    }
    if (choiceMode === 'bus' && recMode === 'bus') {
        const choiceLine = choice.busLine != null ? String(choice.busLine) : (choiceParts.mode === 'bus' ? choiceParts.line || null : null);
        const recLine = recommendation.busLine != null ? String(recommendation.busLine) : (recParts.mode === 'bus' ? recParts.line || null : null);
        if (choiceLine && recLine && choiceLine !== recLine) {
            return 'line';
        }
        const choiceBoard = choice.boardingStopId != null ? String(choice.boardingStopId) : (choiceParts.mode === 'bus' ? choiceParts.boardingStopId || null : null);
        const recBoard = recommendation.boardingStopId != null ? String(recommendation.boardingStopId) : (recParts.mode === 'bus' ? recParts.boardingStopId || null : null);
        const choiceAlight = choice.alightStopId != null ? String(choice.alightStopId) : (choiceParts.mode === 'bus' ? choiceParts.alightStopId || null : null);
        const recAlight = recommendation.alightStopId != null ? String(recommendation.alightStopId) : (recParts.mode === 'bus' ? recParts.alightStopId || null : null);
        if ((choiceBoard && recBoard && choiceBoard !== recBoard) || (choiceAlight && recAlight && choiceAlight !== recAlight)) {
            return 'access';
        }
    }
    return 'none';
}
