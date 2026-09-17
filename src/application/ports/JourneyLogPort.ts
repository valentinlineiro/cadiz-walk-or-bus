import type { DecisionRecord } from '../../domain/models.js';

export interface JourneyLogPort {
  append(record: DecisionRecord): void;
}
