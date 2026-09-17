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

export interface Arrival {
  line: string;
  destination: string;
  minutes: number;
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

export interface CandidateMetadata {
  line?: string;
  destination?: string;
  boardingStop?: Stop;
  alightStop?: Stop;
  alightDistanceMeters?: number;
  [key: string]: any;
}

export interface JourneyCandidate {
  identity: string;
  mode: 'walk' | 'bus';
  estimatedMinutes: number;
  dataQuality: 'live' | 'degraded';
  estimate: CandidateEstimate;
  metadata?: CandidateMetadata;
  exactJourney?: EvaluatedJourney | null;
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

export interface EvaluatedJourney {
  identity: string;
  mode: 'walk' | 'bus';
  totalMinutes: number;
  dataQuality: 'live' | 'degraded';
  breakdown: EvaluatedJourneyBreakdown;
  routes: EvaluatedJourneyRoutes;
  metadata?: CandidateMetadata;
  candidate?: JourneyCandidate;
}

export interface DecisionAlternative {
  journey: EvaluatedJourney;
  differentiator: string;
  deltaMinutes: number;
  divergenceType: DivergenceType;
}

export interface Decision {
  hero: EvaluatedJourney;
  alternatives: DecisionAlternative[];
}

export interface DecisionRecord {
  id?: string;
  timestamp: number;
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

