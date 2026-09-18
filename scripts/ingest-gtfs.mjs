import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value !== '')) rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, '').trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function secondsFromGtfsTime(value) {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid GTFS time: ${value}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function dateValue(value) {
  if (!/^\d{8}$/.test(value)) throw new Error(`Invalid GTFS date: ${value}`);
  return value;
}

function truthy(value) {
  return value === '1';
}

export function buildSnapshot(files, options = {}) {
  const required = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt'];
  for (const file of required) {
    if (!(file in files)) throw new Error(`Missing GTFS file: ${file}`);
  }

  const agencies = parseCsv(files['agency.txt']);
  const agencyNeedle = String(options.agencyName ?? 'Bahía de Cádiz').toLocaleLowerCase();
  const agencyIds = new Set(
    agencies
      .filter((agency) => agency.agency_name.toLocaleLowerCase().includes(agencyNeedle))
      .map((agency) => agency.agency_id),
  );
  if (agencyIds.size === 0) throw new Error(`No GTFS agency matches: ${options.agencyName ?? 'Bahía de Cádiz'}`);

  const routes = parseCsv(files['routes.txt']).filter((route) => agencyIds.has(route.agency_id));
  const routeById = new Map(routes.map((route) => [route.route_id, route]));
  const trips = parseCsv(files['trips.txt']).filter((trip) => routeById.has(trip.route_id));
  const tripById = new Map(trips.map((trip) => [trip.trip_id, trip]));
  const stopTimesByTrip = new Map();
  for (const row of parseCsv(files['stop_times.txt'])) {
    if (!tripById.has(row.trip_id)) continue;
    const times = stopTimesByTrip.get(row.trip_id) ?? [];
    times.push({
      stop: String(row.stop_id),
      arrivalSeconds: secondsFromGtfsTime(row.arrival_time),
      departureSeconds: secondsFromGtfsTime(row.departure_time),
      sequence: Number(row.stop_sequence),
    });
    stopTimesByTrip.set(row.trip_id, times);
  }

  const selectedStopIds = new Set([...stopTimesByTrip.values()].flat().map((time) => time.stop));
  const stops = parseCsv(files['stops.txt'])
    .filter((stop) => selectedStopIds.has(String(stop.stop_id)))
    .map((stop) => ({
      stop: String(stop.stop_id),
      name: stop.stop_name,
      lat: Number(stop.stop_lat),
      lon: Number(stop.stop_lon),
    }));

  const services = parseCsv(files['calendar.txt']).map((service) => ({
    serviceId: service.service_id,
    startDate: dateValue(service.start_date),
    endDate: dateValue(service.end_date),
    weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => truthy(service[day])),
    addedDates: [],
    removedDates: [],
  }));
  const serviceById = new Map(services.map((service) => [service.serviceId, service]));
  for (const exception of parseCsv(files['calendar_dates.txt'])) {
    const service = serviceById.get(exception.service_id);
    if (!service) continue;
    const date = dateValue(exception.date);
    if (exception.exception_type === '1') service.addedDates.push(date);
    if (exception.exception_type === '2') service.removedDates.push(date);
  }

  const lines = {};
  const normalizedTrips = [];
  for (const trip of trips) {
    const times = (stopTimesByTrip.get(trip.trip_id) ?? []).sort((a, b) => a.sequence - b.sequence);
    if (times.length === 0 || !serviceById.has(trip.service_id)) continue;
    const route = routeById.get(trip.route_id);
    const line = String(route.route_short_name || route.route_id);
    const direction = String(trip.direction_id ?? '').trim();
    const destination = trip.trip_headsign || (direction ? `${line} dirección ${direction}` : line);
    lines[line] ??= {};
    lines[line][destination] ??= times.map(({ stop }) => stop);
    normalizedTrips.push({
      tripId: String(trip.trip_id),
      line,
      destination,
      serviceId: String(trip.service_id),
      stopTimes: times.map(({ stop, arrivalSeconds, departureSeconds }) => ({ stop, arrivalSeconds, departureSeconds })),
    });
  }

  return {
    feedVersion: String(options.feedVersion ?? 'unknown'),
    generatedAt: String(options.generatedAt ?? new Date().toISOString()),
    source: 'nap',
    stops,
    lines,
    services: services.filter((service) => normalizedTrips.some((trip) => trip.serviceId === service.serviceId)),
    trips: normalizedTrips,
  };
}

function readZipFiles(inputPath) {
  const required = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt'];
  return Object.fromEntries(required.map((file) => [
    file,
    execFileSync('unzip', ['-p', inputPath, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  ]));
}

function cliArgs(argv) {
  const args = Object.fromEntries(argv.slice(2).reduce((pairs, value, index, values) => {
    if (!value.startsWith('--')) return pairs;
    pairs.push([value.slice(2), values[index + 1] ?? true]);
    return pairs;
  }, []));
  if (!args.input || !args.output || !args['feed-version']) {
    throw new Error('Usage: npm run ingest:gtfs -- --input feed.zip --output snapshot.json --feed-version nap-YYYY-MM-DD [--agency-name "Bahía de Cádiz"]');
  }
  return args;
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) {
  const args = cliArgs(process.argv);
  const snapshot = buildSnapshot(readZipFiles(args.input), {
    feedVersion: args['feed-version'],
    generatedAt: args['generated-at'],
    agencyName: args['agency-name'],
  });
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(snapshot, null, 2)}\n`);
}
