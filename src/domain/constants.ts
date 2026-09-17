// Domain transport kinematics (pace constants)
// WALK_METERS_PER_MINUTE: constant urban walking pace (4.8 km/h = 80 m/min).
export const WALK_METERS_PER_MINUTE = 80;

// BUS_METERS_PER_MINUTE: constant urban bus pace (~15 km/h = 250 m/min, including stops and traffic).
export const BUS_METERS_PER_MINUTE = 250;

// Hard planning budget and temporal similarity thresholds
export interface PlanningPolicy {
  maxCandidates?: number;
  maxAlternatives?: number;
  similarityMaxDeltaMinutes?: number;
}

export const DEFAULT_PLANNING_POLICY: PlanningPolicy = {
  maxCandidates: 3,
  maxAlternatives: 2,
  similarityMaxDeltaMinutes: 5,
};

// Structural diversity thresholds
export interface DiversityThresholds {
  accessWalkMinutes?: number;
  alightDistanceMeters?: number;
}

export const DEFAULT_DIVERSITY_THRESHOLDS: DiversityThresholds = {
  accessWalkMinutes: 3,
  alightDistanceMeters: 250,
};

