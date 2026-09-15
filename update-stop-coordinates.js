import fs from 'node:fs';
import path from 'node:path';

const R = 6371000;
function distMeters(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export function performCoordinateUpdate(stops, osmData) {
  const osmByRef = new Map();
  for (const el of osmData.elements || []) {
    const ref = el.tags?.ref?.trim();
    if (!ref) continue;
    if (!osmByRef.has(ref)) osmByRef.set(ref, []);
    osmByRef.get(ref).push(el);
  }

  const updatedStops = [];
  const log = {
    exactMatches: [],
    quarantinedNoMatch: [],
    quarantinedDuplicates: [],
  };

  for (const stop of stops) {
    const ref = String(stop.stop ?? stop.number).trim();
    const osmNodes = osmByRef.get(ref) || [];

    if (osmNodes.length === 1) {
      const osmNode = osmNodes[0];
      const deviationMeters = distMeters(stop.lat, stop.lon, osmNode.lat, osmNode.lon);
      log.exactMatches.push({
        ref,
        name: stop.name,
        oldLat: stop.lat,
        oldLon: stop.lon,
        newLat: osmNode.lat,
        newLon: osmNode.lon,
        deviationMeters,
      });

      updatedStops.push({
        name: stop.name,
        number: stop.number,
        stop: stop.stop,
        lat: osmNode.lat,
        lon: osmNode.lon,
      });
    } else if (osmNodes.length === 0) {
      log.quarantinedNoMatch.push({ ref, name: stop.name, lat: stop.lat, lon: stop.lon });
      updatedStops.push({ ...stop });
    } else {
      log.quarantinedDuplicates.push({
        ref,
        name: stop.name,
        nodeCount: osmNodes.length,
        lat: stop.lat,
        lon: stop.lon,
      });
      updatedStops.push({ ...stop });
    }
  }

  return { updatedStops, log };
}

if (process.argv[1] && process.argv[1].endsWith('update-stop-coordinates.js')) {
  const stopsPath = path.resolve('stops.json');
  const osmPath = path.resolve('cadiz_osm_platforms.json');

  const stops = JSON.parse(fs.readFileSync(stopsPath, 'utf8'));
  const osmData = JSON.parse(fs.readFileSync(osmPath, 'utf8'));

  const { updatedStops, log } = performCoordinateUpdate(stops, osmData);

  // Assertions
  if (updatedStops.length !== stops.length) {
    throw new Error(`Stop count mismatch: ${updatedStops.length} vs ${stops.length}`);
  }
  if (log.exactMatches.length !== 95) {
    throw new Error(`Expected exactly 95 exact matches, got ${log.exactMatches.length}`);
  }
  if (log.quarantinedNoMatch.length !== 26) {
    throw new Error(`Expected exactly 26 no-match, got ${log.quarantinedNoMatch.length}`);
  }
  if (log.quarantinedDuplicates.length !== 2) {
    throw new Error(`Expected exactly 2 duplicate refs, got ${log.quarantinedDuplicates.length}`);
  }

  // Schema check: each stop must maintain exactly [lat, lon, name, number, stop]
  for (const s of updatedStops) {
    const keys = Object.keys(s).sort().join(',');
    if (keys !== 'lat,lon,name,number,stop') {
      throw new Error(`Schema violation for stop ${s.stop}: ${keys}`);
    }
  }

  fs.writeFileSync(stopsPath, JSON.stringify(updatedStops, null, 2) + '\n');
  console.log(`Successfully updated stops.json: 95 coordinates updated from physical platforms, 28 preserved in quarantine.`);
}
