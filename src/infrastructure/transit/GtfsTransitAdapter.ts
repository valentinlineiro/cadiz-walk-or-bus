import type { TransitDataPort } from '../../application/ports/TransitDataPort.js';
import type { Arrival, LinesTopology, Stop } from '../../domain/models.js';

export interface GtfsService {
  serviceId: string;
  startDate: string;
  endDate: string;
  weekdays: boolean[];
  addedDates: string[];
  removedDates: string[];
}

export interface GtfsStopTime {
  stop: string;
  arrivalSeconds: number;
  departureSeconds: number;
}

export interface GtfsTrip {
  tripId: string;
  line: string;
  destination: string;
  serviceId: string;
  stopTimes: GtfsStopTime[];
}

export interface GtfsSnapshot {
  feedVersion: string;
  generatedAt: string;
  source: 'nap';
  stops: Stop[];
  lines: LinesTopology;
  services: GtfsService[];
  trips: GtfsTrip[];
}

interface Clock {
  now: () => Date;
}

const MADRID_DATE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function madridNow(date: Date): { dateKey: string; seconds: number; weekday: number } {
  const values = Object.fromEntries(
    MADRID_DATE_PARTS.formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>;
  const dateKey = `${values.year}${String(values.month).padStart(2, '0')}${String(values.day).padStart(2, '0')}`;
  const sundayFirst = new Date(Date.UTC(values.year, values.month - 1, values.day)).getUTCDay();
  return {
    dateKey,
    seconds: values.hour * 3600 + values.minute * 60 + values.second,
    weekday: (sundayFirst + 6) % 7,
  };
}

function serviceRuns(service: GtfsService, dateKey: string, weekday: number): boolean {
  if (service.removedDates.includes(dateKey)) return false;
  if (service.addedDates.includes(dateKey)) return true;
  if (dateKey < service.startDate || dateKey > service.endDate) return false;
  return service.weekdays[weekday] === true;
}

function previousDateKey(dateKey: string): string {
  const date = new Date(Date.UTC(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(4, 6)) - 1,
    Number(dateKey.slice(6, 8)) - 1,
  ));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

export class GtfsTransitAdapter implements TransitDataPort {
  private readonly clock: Clock;

  constructor(
    private readonly snapshot: GtfsSnapshot,
    clock: Clock = { now: () => new Date() },
  ) {
    this.clock = clock;
  }

  getMetadata(): Pick<GtfsSnapshot, 'feedVersion' | 'generatedAt' | 'source'> {
    return {
      feedVersion: this.snapshot.feedVersion,
      generatedAt: this.snapshot.generatedAt,
      source: this.snapshot.source,
    };
  }

  async getStops(): Promise<Stop[]> {
    return this.snapshot.stops;
  }

  async getLines(): Promise<LinesTopology> {
    return this.snapshot.lines;
  }

  async getArrivals(stopId: string | number): Promise<Arrival[]> {
    const { dateKey, seconds, weekday } = madridNow(this.clock.now());
    const previousKey = previousDateKey(dateKey);
    const previousWeekday = (weekday + 6) % 7;
    const nowOnTimeline = 86400 + seconds;
    const serviceDays = [
      { dateKey: previousKey, weekday: previousWeekday, timelineOffset: 0 },
      { dateKey, weekday, timelineOffset: 86400 },
    ].filter(({ dateKey: serviceDate, weekday: serviceWeekday }) =>
      this.snapshot.services.some((service) => serviceRuns(service, serviceDate, serviceWeekday)),
    );
    const activeServiceDays = new Map(
      serviceDays.map(({ dateKey: serviceDate, weekday: serviceWeekday, timelineOffset }) => [
        `${serviceDate}:${serviceWeekday}`,
        {
          timelineOffset,
          services: new Set(
            this.snapshot.services
              .filter((service) => serviceRuns(service, serviceDate, serviceWeekday))
              .map((service) => service.serviceId),
          ),
        },
      ]),
    );

    return this.snapshot.trips
      .flatMap((trip) => {
        return [...activeServiceDays.values()]
          .filter(({ services }) => services.has(trip.serviceId))
          .map(({ timelineOffset }) => ({ trip, timelineOffset }));
      })
      .flatMap((trip) => {
        const stopTime = trip.trip.stopTimes.find((time) => String(time.stop) === String(stopId));
        const departureOnTimeline = (trip.timelineOffset ?? 0) + (stopTime?.departureSeconds ?? 0);
        if (!stopTime || departureOnTimeline < nowOnTimeline) return [];
        return [{
          line: String(trip.trip.line),
          destination: trip.trip.destination,
          minutes: Math.ceil((departureOnTimeline - nowOnTimeline) / 60),
          source: 'scheduled' as const,
        }];
      })
      .sort((a, b) => a.minutes - b.minutes || a.line.localeCompare(b.line));
  }
}
