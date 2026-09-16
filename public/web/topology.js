const R = 6371000; // meters
export function haversineMeters(lat1, lon1, lat2, lon2) {
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
function stripAccents(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
export function stopLineMap(lines) {
    const map = new Map();
    if (!lines)
        return map;
    for (const [line, directions] of Object.entries(lines)) {
        for (const sequence of Object.values(directions)) {
            if (!Array.isArray(sequence))
                continue;
            for (const stopId of sequence) {
                const key = String(stopId);
                if (!map.has(key))
                    map.set(key, new Set());
                map.get(key).add(line);
            }
        }
    }
    return map;
}
export function diversifyByLine(sortedStops, lines, n) {
    const linesByStop = stopLineMap(lines);
    const covered = new Set();
    const picked = [];
    const leftover = [];
    for (const s of sortedStops) {
        const stopLines = linesByStop.get(String(s.stop ?? s.number)) ?? new Set();
        const isNew = stopLines.size === 0 || [...stopLines].some((l) => !covered.has(l));
        if (isNew && picked.length < n) {
            picked.push(s);
            for (const l of stopLines)
                covered.add(l);
        }
        else {
            leftover.push(s);
        }
    }
    for (const s of leftover) {
        if (picked.length >= n)
            break;
        picked.push(s);
    }
    return picked;
}
export function matchDirection(lineDirections, destination) {
    if (!lineDirections || !destination)
        return null;
    const raw = String(destination).trim().toUpperCase();
    const target = raw.replace(/^(L\s*\d+|\d+)\s*[-:·/]?\s*/i, '').trim();
    if (!target)
        return null;
    const targetNorm = stripAccents(target);
    const keys = Object.keys(lineDirections);
    // 1. Exact match (case and accent insensitive)
    const exactMatches = keys.filter((k) => stripAccents(k.toUpperCase().trim()) === targetNorm);
    if (exactMatches.length === 1)
        return exactMatches[0];
    if (exactMatches.length > 1)
        return null;
    // 2. Substring match (either target contains key or key contains target)
    const subMatches = keys.filter((k) => {
        const kNorm = stripAccents(k.toUpperCase().trim());
        return kNorm.includes(targetNorm) || targetNorm.includes(kNorm);
    });
    if (subMatches.length === 1)
        return subMatches[0];
    if (subMatches.length > 1)
        return null;
    // 3. Significant word match (words with length > 3)
    const words = targetNorm.split(/\s+/).filter((w) => w.length > 3);
    if (words.length > 0) {
        const wordMatches = keys.filter((k) => {
            const kNorm = stripAccents(k.toUpperCase().trim());
            return words.some((w) => kNorm.includes(w));
        });
        if (wordMatches.length === 1)
            return wordMatches[0];
        if (wordMatches.length > 1)
            return null;
    }
    return null;
}
export function findAlightStop({ line, direction, boardingStopId, destCoords, stops, lines, }) {
    if (!line || !direction || boardingStopId == null || !destCoords || !stops || !lines)
        return null;
    if (!Number.isFinite(destCoords.lat) || !Number.isFinite(destCoords.lon))
        return null;
    const lineInfo = lines[String(line)];
    if (!lineInfo)
        return null;
    const dirKey = matchDirection(lineInfo, direction);
    if (!dirKey)
        return null;
    const sequence = lineInfo[dirKey];
    if (!Array.isArray(sequence) || sequence.length < 2)
        return null;
    const boardingStr = String(boardingStopId);
    const boardingIdx = sequence.findIndex((id) => String(id) === boardingStr);
    if (boardingIdx === -1 || boardingIdx >= sequence.length - 1)
        return null;
    const stopMap = new Map();
    for (const s of stops) {
        stopMap.set(String(s.stop ?? s.number), s);
    }
    const boardingStopObj = stopMap.get(boardingStr);
    if (!boardingStopObj || !Number.isFinite(boardingStopObj.lat) || !Number.isFinite(boardingStopObj.lon)) {
        return null;
    }
    const boardingDist = haversineMeters(boardingStopObj.lat, boardingStopObj.lon, destCoords.lat, destCoords.lon);
    const subsequentIds = sequence.slice(boardingIdx + 1);
    let bestCandidate = null;
    let bestOffset = -1;
    let minDistance = Infinity;
    subsequentIds.forEach((stopId, offset) => {
        const stopObj = stopMap.get(String(stopId));
        if (!stopObj || !Number.isFinite(stopObj.lat) || !Number.isFinite(stopObj.lon))
            return;
        const dist = haversineMeters(stopObj.lat, stopObj.lon, destCoords.lat, destCoords.lon);
        // Rule: candidate must be strictly closer to destination than the boarding stop
        if (dist >= boardingDist)
            return;
        // Minimization with deterministic tie-breaker (earlier in sequence wins on strict inequality)
        if (dist < minDistance) {
            minDistance = dist;
            bestCandidate = stopObj;
            bestOffset = offset;
        }
    });
    if (!bestCandidate)
        return null;
    const path = [boardingStopObj, ...subsequentIds.slice(0, bestOffset + 1).map((id) => stopMap.get(String(id)))]
        .filter((s) => Boolean(s && Number.isFinite(s.lat) && Number.isFinite(s.lon)));
    let rideMeters = 0;
    for (let i = 1; i < path.length; i++) {
        rideMeters += haversineMeters(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
    }
    return {
        stop: bestCandidate,
        distanceMeters: minDistance,
        direction: dirKey,
        path,
        rideMeters,
    };
}
