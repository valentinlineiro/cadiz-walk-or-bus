import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from './ingest-gtfs.mjs';

const files = {
  'agency.txt': 'agency_id,agency_name\nconsorcio,Red de Consorcios de Transporte Metropolitano de Andalucía - Bahía de Cádiz\nother,Otra red\n',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nA,Parada A,36.52,-6.28\nB,Parada B,36.53,-6.29\n',
  'routes.txt': 'route_id,agency_id,route_short_name,route_long_name\nr1,consorcio,1,Línea 1\nr2,other,9,Otra línea\n',
  'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,0,0,20260101,20301231\n',
  'calendar_dates.txt': 'service_id,date,exception_type\nsvc,20260918,2\n',
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign,direction_id\nr1,svc,t1,Centro,0\nr2,svc,t2,Otra,0\n',
  'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,A,1\nt1,08:10:00,08:10:00,B,2\nt2,08:00:00,08:00:00,A,1\n',
};

test('buildSnapshot filters the selected agency and preserves GTFS schedules and exceptions', () => {
  const snapshot = buildSnapshot(files, {
    feedVersion: 'nap-test',
    generatedAt: '2026-09-17T03:31:55Z',
    agencyName: 'Bahía de Cádiz',
  });

  assert.equal(snapshot.source, 'nap');
  assert.equal(snapshot.feedVersion, 'nap-test');
  assert.deepEqual(snapshot.stops.map((stop) => stop.stop), ['A', 'B']);
  assert.deepEqual(snapshot.lines, { '1': { Centro: ['A', 'B'] } });
  assert.deepEqual(snapshot.services[0].removedDates, ['20260918']);
  assert.deepEqual(snapshot.trips[0].stopTimes, [
    { stop: 'A', arrivalSeconds: 28800, departureSeconds: 28800 },
    { stop: 'B', arrivalSeconds: 29400, departureSeconds: 29400 },
  ]);
});
