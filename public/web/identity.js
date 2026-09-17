export function createWalkIdentity() {
    return 'walk:direct';
}
export function createBusIdentity(line, boardingStopId, alightStopId) {
    return `bus:${String(line)}:${String(boardingStopId)}:${String(alightStopId)}`;
}
export function parseIdentity(identity) {
    if (!identity || typeof identity !== 'string') {
        return { mode: 'unknown', raw: '' };
    }
    if (identity.startsWith('walk')) {
        return { mode: 'walk', variant: 'direct' };
    }
    if (identity.startsWith('bus:')) {
        const parts = identity.split(':');
        return {
            mode: 'bus',
            line: parts[1] || '',
            boardingStopId: parts[2] || '',
            alightStopId: parts[3] || '',
        };
    }
    return { mode: 'unknown', raw: identity };
}
export function isSameIdentity(a, b) {
    if (!a || !b)
        return false;
    return a === b;
}
