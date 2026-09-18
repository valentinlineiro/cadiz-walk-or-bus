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
function previousDateKey(dateKey) {
    const date = new Date(Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(4, 6)) - 1, Number(dateKey.slice(6, 8)) - 1));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}
export class GtfsTransitAdapter {
    snapshot;
    clock;
    constructor(snapshot, clock = { now: () => new Date() }) {
        this.snapshot = snapshot;
        this.clock = clock;
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
        const previousKey = previousDateKey(dateKey);
        const previousWeekday = (weekday + 6) % 7;
        const activeServices = new Set(this.snapshot.services
            .filter((service) => serviceRuns(service, dateKey, weekday))
            .map((service) => service.serviceId));
        const previousServices = new Set(this.snapshot.services
            .filter((service) => serviceRuns(service, previousKey, previousWeekday))
            .map((service) => service.serviceId));
        return this.snapshot.trips
            .flatMap((trip) => {
            const serviceDayOffsets = [
                ...(activeServices.has(trip.serviceId) ? [0] : []),
                ...(previousServices.has(trip.serviceId) ? [86400] : []),
            ];
            return serviceDayOffsets.map((serviceDayOffset) => ({ trip, serviceDayOffset }));
        })
            .flatMap((trip) => {
            const stopTime = trip.trip.stopTimes.find((time) => String(time.stop) === String(stopId));
            if (!stopTime || stopTime.departureSeconds < trip.serviceDayOffset + seconds)
                return [];
            return [{
                    line: String(trip.trip.line),
                    destination: trip.trip.destination,
                    minutes: Math.ceil((stopTime.departureSeconds - trip.serviceDayOffset - seconds) / 60),
                    source: 'scheduled',
                }];
        })
            .sort((a, b) => a.minutes - b.minutes || a.line.localeCompare(b.line));
    }
}
