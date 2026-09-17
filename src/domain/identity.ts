export interface WalkIdentityParts {
  mode: 'walk';
  variant: 'direct';
}

export interface BusIdentityParts {
  mode: 'bus';
  line: string;
  boardingStopId: string;
  alightStopId: string;
}

export interface UnknownIdentityParts {
  mode: 'unknown';
  raw: string;
}

export type JourneyIdentityParts = WalkIdentityParts | BusIdentityParts | UnknownIdentityParts;

export function createWalkIdentity(): string {
  return 'walk:direct';
}

export function createBusIdentity(
  line: string | number,
  boardingStopId: string | number,
  alightStopId: string | number
): string {
  return `bus:${String(line)}:${String(boardingStopId)}:${String(alightStopId)}`;
}

export function parseIdentity(identity: string | null | undefined): JourneyIdentityParts {
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

export function isSameIdentity(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  return a === b;
}
