export function isValidCapturedAt(capturedAt) {
  if (typeof capturedAt !== 'string') return false;
  return !isNaN(Date.parse(capturedAt));
}

export function normalizeScenario(raw) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.error) {
    return {
      capturedAt: raw.capturedAt,
      error: raw.error,
    };
  }

  const origin = raw.origin ?? raw.me;
  const destination = raw.destination ?? raw.dest;

  if (!origin || !destination) return null;

  const { me, dest, ...rest } = raw;

  return {
    ...rest,
    origin,
    destination,
  };
}
