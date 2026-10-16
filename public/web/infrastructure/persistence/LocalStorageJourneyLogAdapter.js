import { parseIdentity } from '../../domain/identity.js';
import { isRetained } from '../../domain/constants.js';
export const STORAGE_KEY = 'cadiz_journey_log';
export const DEDUPE_WINDOW_MS = 300000; // 5 minutes
export const DEDUPE_COORD_EPSILON = 0.0002;
export const MAX_ENTRIES = 200;
export function formatRecommendationSub(rec) {
    if (!rec)
        return null;
    const isBus = rec.mode === 'bus' || rec.kind === 'bus';
    const isWalk = rec.mode === 'walk' || rec.kind === 'walk';
    if (!isBus && !isWalk)
        return null;
    if (isBus) {
        const rawLine = rec.busLine ?? rec.line;
        const lineStr = rawLine ? (String(rawLine).startsWith('L') ? rawLine : `L${rawLine}`) + ' · ' : '';
        const mins = rec.totalMinutes ?? rec.minutes;
        const total = mins != null ? `${mins}′` : '';
        return `última vez: BUS ${lineStr}${total}`.trim();
    }
    if (isWalk) {
        const mins = rec.walkMinutes ?? rec.totalMinutes ?? rec.minutes;
        if (mins != null) {
            return `última vez: ANDAR · ${mins}′`;
        }
        return 'última vez: ANDAR';
    }
    return null;
}
function sameDestination(d1, d2) {
    if (!d1 || !d2)
        return false;
    return Math.abs(Number(d1.lat) - Number(d2.lat)) < DEDUPE_COORD_EPSILON && Math.abs(Number(d1.lon) - Number(d2.lon)) < DEDUPE_COORD_EPSILON;
}
function normalizeEntry(item) {
    if (!item || !item.recommendation)
        return null;
    let choice = item.choice ?? null;
    const choiceId = typeof choice === 'string' ? choice : (choice && typeof choice === 'object' ? String(choice.identity || '') : '');
    const choiceParts = parseIdentity(choiceId);
    let normalizedChoice = null;
    if (typeof choice === 'string') {
        const isWalk = choiceParts?.mode === 'walk';
        normalizedChoice = {
            identity: choice,
            mode: isWalk ? 'walk' : 'bus',
            busLine: (choiceParts?.mode === 'bus' ? choiceParts.line : null) || (item.recommendation.busLine != null ? String(item.recommendation.busLine) : null),
            boardingStopId: (choiceParts?.mode === 'bus' ? choiceParts.boardingStopId : null) || (item.recommendation.boardingStopId != null ? String(item.recommendation.boardingStopId) : null),
            alightStopId: (choiceParts?.mode === 'bus' ? choiceParts.alightStopId : null) || (item.recommendation.alightStopId != null ? String(item.recommendation.alightStopId) : null),
            totalMinutes: item.recommendation.totalMinutes != null ? Number(item.recommendation.totalMinutes) : 0,
            deltaMinutes: 0,
            divergenceType: 'none',
        };
    }
    else if (choice && typeof choice === 'object') {
        normalizedChoice = {
            identity: choiceId,
            mode: choice.mode === 'walk' ? 'walk' : 'bus',
            busLine: choice.busLine != null ? String(choice.busLine) : (choiceParts?.mode === 'bus' ? choiceParts.line || null : null),
            boardingStopId: choice.boardingStopId != null ? String(choice.boardingStopId) : (choiceParts?.mode === 'bus' ? choiceParts.boardingStopId || null : null),
            alightStopId: choice.alightStopId != null ? String(choice.alightStopId) : (choiceParts?.mode === 'bus' ? choiceParts.alightStopId || null : null),
            totalMinutes: Number(choice.totalMinutes) || 0,
            deltaMinutes: Number.isFinite(Number(choice.deltaMinutes)) ? Number(choice.deltaMinutes) : 0,
            divergenceType: choice.divergenceType || 'none',
        };
    }
    const recIdentity = item.recommendation.identity ??
        (item.recommendation.kind === 'walk' || item.recommendation.mode === 'walk'
            ? 'walk:direct'
            : (item.recommendation.busLine ? `bus:${item.recommendation.busLine}` : 'bus:unknown'));
    const recParts = parseIdentity(recIdentity);
    const recBoarding = item.recommendation.boardingStopId != null
        ? String(item.recommendation.boardingStopId)
        : (recParts?.mode === 'bus' ? recParts.boardingStopId || null : null);
    const recAlight = item.recommendation.alightStopId != null
        ? String(item.recommendation.alightStopId)
        : (recParts?.mode === 'bus' ? recParts.alightStopId || null : null);
    const normalized = {
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
        ...(typeof item.startedAt === 'number' ? { startedAt: item.startedAt } : {}),
        destination: {
            label: item.destination?.label != null ? String(item.destination.label).trim() : '',
            lat: Number(item.destination?.lat),
            lon: Number(item.destination?.lon),
        },
        recommendation: {
            identity: recIdentity,
            kind: item.recommendation.kind ?? item.recommendation.mode ?? 'walk',
            walkMinutes: item.recommendation.walkMinutes ?? null,
            busLine: item.recommendation.busLine != null ? String(item.recommendation.busLine) : (recParts?.mode === 'bus' ? recParts.line || null : null),
            boardingStopId: recBoarding,
            alightStopId: recAlight,
            totalMinutes: item.recommendation.totalMinutes ?? null,
        },
        choice: normalizedChoice,
    };
    if (item.id !== undefined) {
        normalized.id = String(item.id);
    }
    return normalized;
}
export class LocalStorageJourneyLogAdapter {
    storageImpl;
    now;
    constructor(storageImpl = typeof localStorage !== 'undefined' ? localStorage : null, now = () => Date.now()) {
        this.storageImpl = storageImpl;
        this.now = now;
    }
    /** Forget the whole log. Favourites live elsewhere and are not touched. */
    clear() {
        try {
            this.storageImpl?.removeItem(STORAGE_KEY);
        }
        catch {
            // storage disabled: nothing to clear
        }
    }
    /** Physically drop entries past the retention window (reads already ignore them). */
    purgeExpired() {
        if (!this.storageImpl)
            return;
        try {
            const raw = this.storageImpl.getItem(STORAGE_KEY);
            if (!raw)
                return;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return;
            const now = this.now();
            const kept = parsed.filter((item) => item && isRetained(item.timestamp, now));
            if (kept.length !== parsed.length)
                this.storageImpl.setItem(STORAGE_KEY, JSON.stringify(kept));
        }
        catch {
            // unreadable log: leave it, reads already treat it as empty
        }
    }
    getLog() {
        if (!this.storageImpl)
            return [];
        try {
            const raw = this.storageImpl.getItem(STORAGE_KEY);
            if (!raw)
                return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return [];
            return parsed
                .filter((item) => item &&
                typeof item === 'object' &&
                typeof item.id === 'string' &&
                typeof item.timestamp === 'number' &&
                isRetained(item.timestamp, this.now()) &&
                item.destination &&
                typeof item.destination.label === 'string' &&
                Number.isFinite(Number(item.destination.lat)) &&
                Number.isFinite(Number(item.destination.lon)) &&
                item.recommendation &&
                typeof item.recommendation.kind === 'string')
                .map(normalizeEntry)
                .filter((item) => item !== null)
                .slice(0, MAX_ENTRIES);
        }
        catch {
            return [];
        }
    }
    append(record, maxEntries = MAX_ENTRIES) {
        if (!this.storageImpl || !record || !record.destination || !record.recommendation) {
            return;
        }
        const normalized = normalizeEntry(record);
        if (!normalized)
            return;
        if (!normalized.id) {
            normalized.id = `${normalized.timestamp}-${Math.random().toString(36).slice(2, 7)}`;
        }
        try {
            const log = this.getLog();
            const existingIdx = log.findIndex((entry) => sameDestination(entry.destination, normalized.destination) &&
                Math.abs(normalized.timestamp - entry.timestamp) <= DEDUPE_WINDOW_MS);
            if (existingIdx !== -1) {
                const existing = log[existingIdx];
                const merged = {
                    ...existing,
                    id: normalized.id ?? existing.id,
                    timestamp: normalized.timestamp,
                    ...(normalized.startedAt !== undefined ? { startedAt: normalized.startedAt } : {}),
                    destination: normalized.destination,
                    recommendation: normalized.recommendation,
                    choice: normalized.choice ?? existing.choice ?? null,
                };
                log.splice(existingIdx, 1);
                log.unshift(merged);
            }
            else {
                log.unshift(normalized);
            }
            if (log.length > maxEntries) {
                log.length = maxEntries;
            }
            this.storageImpl.setItem(STORAGE_KEY, JSON.stringify(log));
        }
        catch {
            // Ignore QuotaExceededError or security exceptions silently
        }
    }
    getGroupedDestinations() {
        const log = this.getLog();
        const groups = [];
        for (const entry of log) {
            if (!entry.destination)
                continue;
            const existing = groups.find((g) => sameDestination(g, entry.destination));
            if (existing) {
                existing.count++;
                if (entry.timestamp > existing.lastTimestamp) {
                    existing.lastTimestamp = entry.timestamp;
                    existing.label = entry.destination.label ?? existing.label;
                    existing.lat = entry.destination.lat;
                    existing.lon = entry.destination.lon;
                    existing.lastRecommendation = entry.recommendation;
                    existing.sub = formatRecommendationSub(entry.recommendation);
                }
            }
            else {
                groups.push({
                    label: entry.destination.label ?? '',
                    lat: entry.destination.lat,
                    lon: entry.destination.lon,
                    count: 1,
                    lastTimestamp: entry.timestamp,
                    lastRecommendation: entry.recommendation,
                    sub: formatRecommendationSub(entry.recommendation),
                });
            }
        }
        return groups;
    }
    getRecentDestinations(n = 5) {
        const groups = this.getGroupedDestinations();
        groups.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
        return groups.slice(0, n);
    }
    getTopDestinations(n = 5) {
        const groups = this.getGroupedDestinations();
        groups.sort((a, b) => {
            if (b.count !== a.count)
                return b.count - a.count;
            return b.lastTimestamp - a.lastTimestamp;
        });
        return groups.slice(0, n);
    }
}
