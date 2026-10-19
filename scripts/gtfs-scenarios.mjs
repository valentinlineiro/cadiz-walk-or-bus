// Test support: derives dates and trips from a GTFS snapshot itself, so integration tests prove the
// calendar logic on whatever feed is committed without pinning a year, a date or a line.

const MADRID = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'medium' });

const parse = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)));
const format = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
export const shiftDate = (key, days) => format(parse(key) + days * 86_400_000);
const weekdayOf = (key) => (new Date(parse(key)).getUTCDay() + 6) % 7; // 0 = Monday, as in the feed

/** The instant at which Madrid's wall clock reads `seconds` after midnight of `key`. */
export function madridInstant(key, seconds) {
  const wanted = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)} ${new Date(seconds * 1000).toISOString().slice(11, 19)}`;
  for (const offsetHours of [1, 2]) {
    const candidate = new Date(parse(key) + seconds * 1000 - offsetHours * 3_600_000);
    if (MADRID.format(candidate) === wanted) return candidate;
  }
  throw new Error(`no Madrid instant for ${wanted}`);
}

/** Trips whose (line, destination, stop, departure) is unique, so an arrival identifies the trip. */
function identifiableTrips(snapshot) {
  const signature = (trip) => `${trip.line}|${trip.destination}|${trip.stopTimes[0].stop}|${trip.stopTimes[0].departureSeconds}`;
  const counts = new Map();
  for (const trip of snapshot.trips) counts.set(signature(trip), (counts.get(signature(trip)) ?? 0) + 1);
  return snapshot.trips.filter((trip) => counts.get(signature(trip)) === 1
    && trip.stopTimes.length > 1
    && trip.stopTimes[0].departureSeconds >= 8 * 3600 && trip.stopTimes[0].departureSeconds <= 20 * 3600);
}

const scenario = (trip, dateKey) => {
  const first = trip.stopTimes[0];
  return {
    trip,
    dateKey,
    stop: String(first.stop),
    expected: { line: String(trip.line), destination: trip.destination, minutes: 10, source: 'scheduled' },
    at: (key) => madridInstant(key, first.departureSeconds - 600),
    now: madridInstant(dateKey, first.departureSeconds - 600),
  };
};

const serviceById = (snapshot) => new Map(snapshot.services.map((service) => [service.serviceId, service]));

/** A trip on an ordinary date of its service: inside the window, on a running weekday, no exception. */
export function findRegularScenario(snapshot, weekday) {
  const services = serviceById(snapshot);
  for (const trip of identifiableTrips(snapshot)) {
    const service = services.get(trip.serviceId);
    if (!service?.weekdays[weekday]) continue;
    let date = service.startDate;
    while (weekdayOf(date) !== weekday) date = shiftDate(date, 1);
    if (date <= service.endDate && !service.addedDates.includes(date) && !service.removedDates.includes(date)) return scenario(trip, date);
  }
  throw new Error(`snapshot has no identifiable regular trip for weekday ${weekday}`);
}

/** A trip that runs on a date only because of `addedDates` (its weekday is off), with a control date a week earlier. */
export function findAddedDateScenario(snapshot) {
  const services = serviceById(snapshot);
  for (const trip of identifiableTrips(snapshot)) {
    const service = services.get(trip.serviceId);
    const added = service?.addedDates.find((date) => !service.weekdays[weekdayOf(date)] && !service.removedDates.includes(date)
      && !service.addedDates.includes(shiftDate(date, -7)));
    if (added) return { ...scenario(trip, added), controlDateKey: shiftDate(added, -7) };
  }
  throw new Error('snapshot has no trip served only through addedDates');
}
