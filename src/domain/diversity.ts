import {
  DEFAULT_PLANNING_POLICY,
  DEFAULT_DIVERSITY_THRESHOLDS,
  type DiversityThresholds,
  type PlanningPolicy,
} from './constants.js';
import { isSameIdentity, parseIdentity, type JourneyIdentity } from './identity.js';
import type { DivergenceType } from './models.js';

export type { DivergenceType };

/**
 * Closed item shape for diversity comparisons.
 * identity is a structured JourneyIdentity or null (not a string).
 * Walk-specific access fields come from estimate; bus line comes from identity or metadata.
 */
export interface StructurallyDiverseExactJourney {
  walkToStopRoute?: { minutes?: number | null } | null;
  walkToStopMinutes?: number | null;
}

/**
 * Closed item shape for diversity comparisons.
 * Supports both pre-routing candidates and post-routing evaluated items.
 * Access walk respects exactJourney when present, falling back to estimate.
 */
export interface StructurallyDiverseItem {
  identity: JourneyIdentity | string | null | undefined;
  mode?: 'walk' | 'bus' | string;
  metadata?: {
    line?: string | number | null;
    alightDistanceMeters?: number | null;
  };
  exactJourney?: StructurallyDiverseExactJourney | null;
  estimate?: {
    walkToStopMinutes?: number | null;
  } | null;
  estimatedMinutes?: number;
}

/**
 * Determines whether a candidate option is structurally diverse from a reference journey (Hero or alternative).
 *
 * Rules:
 * 1. Modal diversity: WALK vs BUS → always diverse.
 * 2. Line diversity: BUS L1 vs BUS L2 → diverse.
 * 3. Access diversity (same line): walk-to-stop delta ≥ threshold OR alighting distance delta ≥ threshold → diverse.
 *    Walk-to-stop precedence: exactJourney?.walkToStopRoute?.minutes ?? exactJourney?.walkToStopMinutes ?? estimate?.walkToStopMinutes ?? 0
 */
export function isStructurallyDiverse(
  candidate: StructurallyDiverseItem | null | undefined,
  hero: StructurallyDiverseItem | null | undefined,
  thresholds: DiversityThresholds = DEFAULT_DIVERSITY_THRESHOLDS,
): boolean {
  if (!candidate || !hero) return false;
  if (!candidate.identity || !hero.identity) return false;
  if (isSameIdentity(candidate.identity, hero.identity)) return false;

  // 1. Modal diversity
  if (candidate.mode !== hero.mode) {
    return true;
  }

  // 2. Line diversity (for bus)
  if (candidate.mode === 'bus' && hero.mode === 'bus') {
    const candIdent = typeof candidate.identity === 'string' ? parseIdentity(candidate.identity) : candidate.identity;
    const heroIdent = typeof hero.identity === 'string' ? parseIdentity(hero.identity) : hero.identity;

    // Line is read directly from the structured identity, falling back to metadata
    const candLine = candIdent?.mode === 'bus'
      ? candIdent.line
      : (candidate.metadata?.line != null ? String(candidate.metadata.line) : null);
    const heroLine = heroIdent?.mode === 'bus'
      ? heroIdent.line
      : (hero.metadata?.line != null ? String(hero.metadata.line) : null);

    if (candLine && heroLine && candLine !== heroLine) {
      return true;
    }

    // 3. Access diversity (same line)
    const accessWalkThreshold = thresholds?.accessWalkMinutes ?? 3;
    const candWalk = candidate.exactJourney?.walkToStopRoute?.minutes
      ?? candidate.exactJourney?.walkToStopMinutes
      ?? candidate.estimate?.walkToStopMinutes
      ?? 0;
    const heroWalk = hero.exactJourney?.walkToStopRoute?.minutes
      ?? hero.exactJourney?.walkToStopMinutes
      ?? hero.estimate?.walkToStopMinutes
      ?? 0;
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
export function filterDiverseAlternatives<T extends StructurallyDiverseItem>(
  candidates: T[] | null | undefined,
  hero: T | null | undefined,
  policy: PlanningPolicy = DEFAULT_PLANNING_POLICY,
): T[] {
  if (!hero || !Array.isArray(candidates)) return [];
  const maxDelta = policy.similarityMaxDeltaMinutes ?? 5;
  const maxAlts = policy.maxAlternatives ?? 2;
  const maxCandidates = policy.maxCandidates ?? 3;
  const allowedAlternatives = Math.min(maxAlts, Math.max(0, maxCandidates - 1));
  if (allowedAlternatives <= 0) return [];

  const admitted: T[] = [];
  for (const cand of candidates) {
    if (admitted.length >= allowedAlternatives) break;
    if (!cand || !cand.identity) continue;
    if (isSameIdentity(cand.identity, hero.identity)) continue;
    if (typeof cand.estimatedMinutes === 'number' && typeof hero.estimatedMinutes === 'number') {
      if (cand.estimatedMinutes - hero.estimatedMinutes > maxDelta) continue;
    }

    // Must be structurally diverse from the Hero
    if (!isStructurallyDiverse(cand, hero)) continue;

    // Must also be structurally diverse from any already admitted alternative
    if (admitted.some((alt) => !isStructurallyDiverse(cand, alt))) continue;

    admitted.push(cand);
  }

  return admitted;
}

/**
 * Input shapes for classifyDivergence — serialized string identities since
 * this function operates at the persistence/application boundary where
 * choice and recommendation come from localStorage records.
 */
export interface DivergenceChoiceLike {
  identity?: string | null;
  mode?: string | null;
  busLine?: string | number | null;
  boardingStopId?: string | number | null;
  alightStopId?: string | number | null;
}

export interface DivergenceRecommendationLike {
  identity?: string | null;
  kind?: string | null;
  mode?: string | null;
  busLine?: string | number | null;
  boardingStopId?: string | number | null;
  alightStopId?: string | number | null;
}

/**
 * Pure classifier of divergence between user choice and system recommendation.
 * Operates on serialized string identities (persistence boundary) and returns
 * 'none', 'mode', 'line', or 'access'.
 */
export function classifyDivergence(
  choice: DivergenceChoiceLike | null | undefined,
  recommendation: DivergenceRecommendationLike | null | undefined,
): DivergenceType {
  if (!choice || !recommendation) return 'none';

  const choiceParsed = parseIdentity(choice.identity ?? null);
  const recParsed = parseIdentity(recommendation.identity ?? null);

  // Identity-level equality check
  if (choiceParsed && recParsed && isSameIdentity(choiceParsed, recParsed)) return 'none';

  const choiceMode = choice.mode || choiceParsed?.mode || null;
  const recMode = recommendation.kind || recommendation.mode || recParsed?.mode || null;

  if (choiceMode && recMode && choiceMode !== recMode) {
    return 'mode';
  }

  if (choiceMode === 'bus' && recMode === 'bus') {
    const choiceLine = choice.busLine != null ? String(choice.busLine) : (choiceParsed?.mode === 'bus' ? choiceParsed.line : null);
    const recLine = recommendation.busLine != null ? String(recommendation.busLine) : (recParsed?.mode === 'bus' ? recParsed.line : null);

    if (choiceLine && recLine && choiceLine !== recLine) {
      return 'line';
    }

    const choiceBoard = choice.boardingStopId != null ? String(choice.boardingStopId) : (choiceParsed?.mode === 'bus' ? choiceParsed.boardingStopId : null);
    const recBoard = recommendation.boardingStopId != null ? String(recommendation.boardingStopId) : (recParsed?.mode === 'bus' ? recParsed.boardingStopId : null);
    const choiceAlight = choice.alightStopId != null ? String(choice.alightStopId) : (choiceParsed?.mode === 'bus' ? choiceParsed.alightStopId : null);
    const recAlight = recommendation.alightStopId != null ? String(recommendation.alightStopId) : (recParsed?.mode === 'bus' ? recParsed.alightStopId : null);

    if ((choiceBoard && recBoard && choiceBoard !== recBoard) || (choiceAlight && recAlight && choiceAlight !== recAlight)) {
      return 'access';
    }
  }

  return 'none';
}
