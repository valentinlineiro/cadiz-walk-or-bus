const R = 6371000; // meters

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export function matchDirection(lineDirections, destination) {
  if (!lineDirections || !destination) return null;
  const target = destination.toUpperCase().trim();
  const keys = Object.keys(lineDirections);

  // Exact match
  for (const k of keys) {
    if (k.toUpperCase().trim() === target) return k;
  }

  // Substring match
  for (const k of keys) {
    const normK = k.toUpperCase().trim();
    if (normK.includes(target) || target.includes(normK)) return k;
  }

  // First significant word match
  const words = target.split(/\s+/).filter((w) => w.length > 3);
  for (const k of keys) {
    const normK = k.toUpperCase();
    if (words.some((w) => normK.includes(w))) return k;
  }

  return null;
}

export function findAlightStop({ line, direction, boardingStopId, destCoords, stops, lines }) {
  if (!line || !direction || boardingStopId == null || !destCoords || !stops || !lines) return null;
  if (!Number.isFinite(destCoords.lat) || !Number.isFinite(destCoords.lon)) return null;

  const lineInfo = lines[line] ?? lines[String(line)];
  if (!lineInfo) return null;

  const dirKey = matchDirection(lineInfo, direction);
  if (!dirKey) return null;

  const sequence = lineInfo[dirKey];
  if (!Array.isArray(sequence) || sequence.length < 2) return null;

  const boardingStr = String(boardingStopId);
  const boardingIdx = sequence.findIndex((id) => String(id) === boardingStr);
  if (boardingIdx === -1 || boardingIdx >= sequence.length - 1) return null;

  const stopMap = new Map();
  for (const s of stops) {
    stopMap.set(String(s.stop ?? s.number), s);
  }

  const boardingStopObj = stopMap.get(boardingStr);
  if (!boardingStopObj || !Number.isFinite(boardingStopObj.lat) || !Number.isFinite(boardingStopObj.lon)) {
    return null;
  }

  const boardingDist = haversineMeters(
    boardingStopObj.lat,
    boardingStopObj.lon,
    destCoords.lat,
    destCoords.lon
  );

  const subsequentIds = sequence.slice(boardingIdx + 1);
  let bestCandidate = null;
  let minDistance = Infinity;

  for (const stopId of subsequentIds) {
    const stopObj = stopMap.get(String(stopId));
    if (!stopObj || !Number.isFinite(stopObj.lat) || !Number.isFinite(stopObj.lon)) continue;

    const dist = haversineMeters(stopObj.lat, stopObj.lon, destCoords.lat, destCoords.lon);

    // Rule: candidate must be strictly closer to destination than the boarding stop
    if (dist >= boardingDist) continue;

    // Minimization with deterministic tie-breaker (earlier in sequence wins on strict inequality)
    if (dist < minDistance) {
      minDistance = dist;
      bestCandidate = stopObj;
    }
  }

  if (!bestCandidate) return null;

  return {
    stop: bestCandidate,
    distanceMeters: minDistance,
    direction: dirKey,
  };
}
