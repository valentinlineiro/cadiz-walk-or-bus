/**
 * JourneyIdentity — Structured Value Object for journey identity in the domain.
 *
 * The serialized string form (e.g. 'walk:direct', 'bus:1:1106:1204') is an
 * INFRASTRUCTURE concern. Domain code always works with JourneyIdentity objects.
 * Use serializeIdentity() at DOM/storage/network boundaries.
 */
// ─── Constructors ──────────────────────────────────────────────────────────────
export function createWalkIdentity() {
    return { mode: 'walk', variant: 'direct' };
}
export function createBusIdentity(line, boardingStopId, alightStopId) {
    return {
        mode: 'bus',
        line: String(line),
        boardingStopId: String(boardingStopId),
        alightStopId: String(alightStopId),
    };
}
// ─── Infrastructure boundary ───────────────────────────────────────────────────
/**
 * Serializes a JourneyIdentity to a string for DOM attributes, localStorage, or network transport.
 * This is the ONLY place where the serialization format is defined.
 */
export function serializeIdentity(id) {
    if (!id)
        return '';
    if (typeof id === 'string')
        return id;
    if (id.mode === 'walk')
        return `walk:${id.variant}`;
    if (id.mode === 'bus')
        return `bus:${id.line}:${id.boardingStopId}:${id.alightStopId}`;
    return '';
}
/**
 * Parses a serialized identity string back to a JourneyIdentity.
 * Returns null for unknown or malformed strings (not a catch-all 'unknown' mode).
 * Note: 'walk:scenic' and all other walk variants normalize to 'walk:direct' for
 * backward compatibility with legacy serialized entries.
 */
export function parseIdentity(raw) {
    if (!raw || typeof raw !== 'string')
        return null;
    if (raw.startsWith('walk:')) {
        return { mode: 'walk', variant: 'direct' };
    }
    if (raw.startsWith('bus:')) {
        const parts = raw.split(':');
        if (parts.length < 4)
            return null;
        return {
            mode: 'bus',
            line: parts[1] || '',
            boardingStopId: parts[2] || '',
            alightStopId: parts[3] || '',
        };
    }
    return null;
}
// ─── Domain comparison ────────────────────────────────────────────────────────
/**
 * Structurally compares two JourneyIdentity objects (or serialized strings).
 * Accepts null/undefined for convenience at call sites with optional identities.
 */
export function isSameIdentity(a, b) {
    if (!a || !b)
        return false;
    const parsedA = typeof a === 'string' ? parseIdentity(a) : a;
    const parsedB = typeof b === 'string' ? parseIdentity(b) : b;
    if (!parsedA || !parsedB)
        return false;
    if (parsedA.mode !== parsedB.mode)
        return false;
    if (parsedA.mode === 'walk' && parsedB.mode === 'walk')
        return parsedA.variant === parsedB.variant;
    if (parsedA.mode === 'bus' && parsedB.mode === 'bus') {
        return parsedA.line === parsedB.line &&
            parsedA.boardingStopId === parsedB.boardingStopId &&
            parsedA.alightStopId === parsedB.alightStopId;
    }
    return false;
}
