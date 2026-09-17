import type { JourneyLogPort } from '../ports/JourneyLogPort.js';
import type { Coordinates, DecisionAlternative, DecisionRecord, EvaluatedJourney } from '../../domain/models.js';
import { serializeIdentity } from '../../domain/identity.js';

export interface RecordUserChoiceInput {
  destination: Coordinates & { label: string };
  recommendation: EvaluatedJourney;
  choice: DecisionAlternative | null;
  timestamp?: number;
}

export class RecordUserChoiceUseCase {
  constructor(private readonly ports: { journeyLog: JourneyLogPort }) {}

  execute(input: RecordUserChoiceInput): DecisionRecord {
    const timestamp = input.timestamp ?? Date.now();
    const rec = input.recommendation;
    const recBoarding = rec.metadata?.boardingStop?.stop != null
      ? String(rec.metadata.boardingStop.stop)
      : (rec.identity.mode === 'bus' ? rec.identity.boardingStopId : null);
    const recAlight = rec.metadata?.alightStop?.stop != null
      ? String(rec.metadata.alightStop.stop)
      : (rec.identity.mode === 'bus' ? rec.identity.alightStopId : null);
    const recLine = rec.metadata?.line != null
      ? String(rec.metadata.line)
      : (rec.identity.mode === 'bus' ? rec.identity.line : null);

    let choiceRecord: DecisionRecord['choice'] = null;

    if (input.choice) {
      const chJourney = input.choice.journey;
      const chBoarding = chJourney.metadata?.boardingStop?.stop != null
        ? String(chJourney.metadata.boardingStop.stop)
        : (chJourney.identity.mode === 'bus' ? chJourney.identity.boardingStopId : null);
      const chAlight = chJourney.metadata?.alightStop?.stop != null
        ? String(chJourney.metadata.alightStop.stop)
        : (chJourney.identity.mode === 'bus' ? chJourney.identity.alightStopId : null);
      const chLine = chJourney.metadata?.line != null
        ? String(chJourney.metadata.line)
        : (chJourney.identity.mode === 'bus' ? chJourney.identity.line : null);

      choiceRecord = {
        identity: serializeIdentity(chJourney.identity),
        mode: chJourney.mode,
        busLine: chLine,
        boardingStopId: chBoarding,
        alightStopId: chAlight,
        totalMinutes: chJourney.totalMinutes,
        deltaMinutes: input.choice.deltaMinutes,
        divergenceType: input.choice.divergenceType,
      };
    }

    const record: DecisionRecord = {
      id: `${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp,
      destination: {
        label: input.destination.label,
        lat: input.destination.lat,
        lon: input.destination.lon,
      },
      recommendation: {
        identity: serializeIdentity(rec.identity),
        kind: rec.mode,
        walkMinutes: rec.breakdown.walkToStopMinutes + rec.breakdown.lastMileMinutes,
        busLine: recLine,
        boardingStopId: recBoarding,
        alightStopId: recAlight,
        totalMinutes: rec.totalMinutes,
      },
      choice: choiceRecord,
    };

    this.ports.journeyLog.append(record);
    return record;
  }
}
