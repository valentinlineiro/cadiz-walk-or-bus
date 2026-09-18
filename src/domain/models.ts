import type { JourneyIdentity } from './identity.js';

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface Stop {
  stop: string;
  name?: string;
  lat: number;
  lon: number;
  minutes?: number;
  number?: number | string;
}

export interface AlightResolution {
  stop: Stop;
  distanceMeters: number;
  direction: string;
  path: Stop[];
  rideMeters: number;
}

export type ArrivalSource = 'realtime' | 'scheduled';

export interface Arrival {
  line: string;
  destination: string;
  minutes: number;
  source: ArrivalSource;
  alight?: AlightResolution | null;
}

export interface BusDecision {
  minutes: number;
  rideMinutes: number;
  total: number;
  line: string;
  destination: string;
  alight: AlightResolution | null;
}

export type VerdictKind = 'bus' | 'walk';

export interface Verdict {
  kind: VerdictKind;
  walkMinutes: number | null;
  walkToStop: number | null;
  bus: BusDecision | null;
}

export interface Route {
  minutes?: number;
  coordinates: [number, number][];
  status?: 'available' | 'unavailable' | 'service_failure';
}

export interface LinesTopology {
  [line: string]: {
    [direction: string]: Array<string | number>;
  };
}

export interface ScenarioSnapshot {
  capturedAt: string;
  origin: Coordinates;
  destination: Coordinates & { label?: string };
  stops?: Stop[];
  focusedStop?: string | null;
  walkRoute?: Route | null;
  walkToStopRoute?: Route | null;
  busRoute?: Route | null;
  verdict: Verdict;
  error?: { query: string };
}

// --- Formal Domain Contracts (Clean Architecture) ---

export type DivergenceType = 'none' | 'mode' | 'line' | 'access';

export interface CandidateEstimate {
  walkToStopMinutes?: number;
  waitMinutes?: number;
  rideMinutes?: number;
  lastMileMinutes?: number;
}

/**
 * Closed metadata shape — no open index signature.
 * Additional fields surfaced from infrastructure must be added explicitly.
 */
export interface CandidateMetadata {
  line?: string;
  source?: ArrivalSource;
  destination?: string | (Coordinates & { label?: string });
  boardingStop?: Stop;
  alightStop?: Stop;
  alightDistanceMeters?: number;
  origin?: Coordinates;
  path?: Stop[];
}

/**
 * A low-cost planning hypothesis produced before exact routing.
 * The identity is a structured Value Object, not a serialized string.
 * There is no back-reference to EvaluatedJourney — evaluation is a one-way transformation.
 */
export interface JourneyCandidate {
  identity: JourneyIdentity;
  mode: 'walk' | 'bus';
  estimatedMinutes: number;
  dataQuality: 'live' | 'degraded' | 'estimated';
  estimate: CandidateEstimate;
  metadata?: CandidateMetadata;
}

export interface EvaluatedJourneyBreakdown {
  walkToStopMinutes: number;
  waitMinutes: number;
  rideMinutes: number;
  lastMileMinutes: number;
  lastMileDegraded: boolean;
}

export interface EvaluatedJourneyRoutes {
  walkToStopRoute?: Route | null;
  busRoute?: Route | null;
  lastMileRoute?: Route | null;
  walkRoute?: Route | null;
}

/**
 * A journey with physically resolved routes and exact timings.
 * The one-way transformation is: JourneyCandidate → evaluate → EvaluatedJourney.
 * There is no back-reference to JourneyCandidate — that mapping belongs in Application.
 */
export interface EvaluatedJourney {
  identity: JourneyIdentity;
  mode: 'walk' | 'bus';
  totalMinutes: number;
  dataQuality: 'live' | 'degraded';
  breakdown: EvaluatedJourneyBreakdown;
  routes: EvaluatedJourneyRoutes;
  metadata?: CandidateMetadata;
}

export interface DecisionAlternative {
  journey: EvaluatedJourney;
  differentiator: string;
  deltaMinutes: number;
  divergenceType: DivergenceType;
}

export interface Decision {
  hero: EvaluatedJourney | null;
  alternatives: DecisionAlternative[];
  walkMinutes: number | null;
}

/**
 * Serialized form of a decision record for persistence (localStorage, etc.).
 * Identity fields are serialized strings at this boundary (infrastructure concern).
 */
export interface DecisionRecord {
  id?: string;
  timestamp: number;
  startedAt?: number;
  destination: Coordinates & { label: string };
  recommendation: {
    identity: string;
    kind: string;
    walkMinutes?: number | null;
    busLine?: string | null;
    boardingStopId?: string | null;
    alightStopId?: string | null;
    totalMinutes?: number | null;
  };
  choice: {
    identity: string;
    mode: string;
    busLine?: string | null;
    boardingStopId?: string | null;
    alightStopId?: string | null;
    totalMinutes?: number | null;
    divergenceType: DivergenceType;
    deltaMinutes: number;
  } | null;
}
