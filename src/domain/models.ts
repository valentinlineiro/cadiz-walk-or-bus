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
