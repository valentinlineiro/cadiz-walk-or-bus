const MAX_LOOKAHEAD_SECONDS = 3600;
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
function madridNow(date) {
    const values = Object.fromEntries(MADRID_DATE_PARTS.formatToParts(date)
        .filter(({ type }) => type !== 'literal')
        .map(({ type, value }) => [type, Number(value)]));
    const dateKey = `${values.year}${String(values.month).padStart(2, '0')}${String(values.day).padStart(2, '0')}`;
    const sundayFirst = new Date(Date.UTC(values.year, values.month - 1, values.day)).getUTCDay();
    return {
        dateKey,
        seconds: values.hour * 3600 + values.minute * 60 + values.second,
        weekday: (sundayFirst + 6) % 7,
    };
}
function serviceRuns(service, dateKey, weekday) {
    if (service.removedDates.includes(dateKey))
        return false;
    if (service.addedDates.includes(dateKey))
        return true;
    if (dateKey < service.startDate || dateKey > service.endDate)
        return false;
    return service.weekdays[weekday] === true;
}
function shiftDateKey(dateKey, days) {
    const date = new Date(Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8)) + days));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}
export class GtfsTransitAdapter {
    snapshot;
    clock;
    scheduledStopIds;
    constructor(snapshot, clock = { now: () => new Date() }) {
        this.snapshot = snapshot;
        this.clock = clock;
        this.scheduledStopIds = new Set(snapshot.trips.flatMap((trip) => trip.stopTimes.map((time) => String(time.stop))));
    }
    /**
     * Scheduled arrivals ONLY when the schedule can actually answer for this stop today.
     * An id the feed does not know, or a feed with no service running now (expired/not yet valid),
     * is `unavailable`: an empty list from such a feed would be a guess, not "no buses".
     */
    async getArrivalsResult(stopId) {
        if (!this.scheduledStopIds.has(String(stopId))) {
            return { status: 'unavailable', cause: 'no_schedule' };
        }
        const { dateKey, weekday } = madridNow(this.clock.now());
        const anyServiceToday = this.snapshot.services.some((service) => serviceRuns(service, dateKey, weekday));
        if (!anyServiceToday)
            return { status: 'unavailable', cause: 'no_schedule' };
        return { status: 'scheduled', arrivals: await this.getArrivals(stopId) };
    }
    getMetadata() {
        return {
            feedVersion: this.snapshot.feedVersion,
            generatedAt: this.snapshot.generatedAt,
            source: this.snapshot.source,
        };
    }
    async getStops() {
        return this.snapshot.stops;
    }
    async getLines() {
        return this.snapshot.lines;
    }
    async getArrivals(stopId) {
        const { dateKey, seconds, weekday } = madridNow(this.clock.now());
        const nowOnTimeline = 86400 + seconds;
        // Yesterday's service runs past midnight (times above 24:00); tomorrow's early trips fall
        // inside the lookahead shortly before midnight.
        const serviceDays = [
            { dateKey: shiftDateKey(dateKey, -1), weekday: (weekday + 6) % 7, timelineOffset: 0 },
            { dateKey, weekday, timelineOffset: 86400 },
            { dateKey: shiftDateKey(dateKey, 1), weekday: (weekday + 1) % 7, timelineOffset: 2 * 86400 },
        ].filter(({ dateKey: serviceDate, weekday: serviceWeekday }) => this.snapshot.services.some((service) => serviceRuns(service, serviceDate, serviceWeekday)));
        const activeServiceDays = new Map(serviceDays.map(({ dateKey: serviceDate, weekday: serviceWeekday, timelineOffset }) => [
            `${serviceDate}:${serviceWeekday}`,
            {
                timelineOffset,
                services: new Set(this.snapshot.services
                    .filter((service) => serviceRuns(service, serviceDate, serviceWeekday))
                    .map((service) => service.serviceId)),
            },
        ]));
        return this.snapshot.trips
            .flatMap((trip) => {
            return [...activeServiceDays.values()]
                .filter(({ services }) => services.has(trip.serviceId))
                .map(({ timelineOffset }) => ({ trip, timelineOffset }));
        })
            .flatMap((trip) => {
            const stopTime = trip.trip.stopTimes.find((time) => String(time.stop) === String(stopId));
            const departureOnTimeline = (trip.timelineOffset ?? 0) + (stopTime?.departureSeconds ?? 0);
            const waitSeconds = departureOnTimeline - nowOnTimeline;
            if (!stopTime || waitSeconds < 0 || waitSeconds > MAX_LOOKAHEAD_SECONDS)
                return [];
            return [{
                    line: String(trip.trip.line),
                    destination: trip.trip.destination,
                    minutes: Math.ceil(waitSeconds / 60),
                    source: 'scheduled',
                }];
        })
            .sort((a, b) => a.minutes - b.minutes || a.line.localeCompare(b.line));
    }
}
