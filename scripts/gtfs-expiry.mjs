// The scheduled (GTFS) fallback stops answering once the feed's last service date has passed.
// This guard fails the release 30 days before that, measured against today's Madrid date.

export const MIN_DAYS_OF_VALIDITY = 30;

const toIso = (key) => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
const madridDate = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(now);
const dayNumber = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** The latest date on which any service of the feed can run (YYYYMMDD), or null without services. */
export function lastServiceDate(snapshot) {
  const dates = (snapshot.services ?? []).flatMap((service) => [service.endDate, ...(service.addedDates ?? [])]).filter(Boolean);
  return dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null;
}

export function daysUntilLastServiceDate(snapshot, now = new Date()) {
  const last = lastServiceDate(snapshot);
  return last === null ? null : dayNumber(toIso(last)) - dayNumber(madridDate(now));
}

export function findGtfsExpiryProblems(snapshot, now = new Date()) {
  const last = lastServiceDate(snapshot);
  if (last === null) return [`GTFS snapshot ${snapshot.feedVersion ?? ''} has no service dates: the scheduled fallback cannot answer.`.replace('  ', ' ')];
  const days = daysUntilLastServiceDate(snapshot, now);
  const renew = 'Renew the snapshot (`npm run ingest:gtfs -- --input feed.zip --output public/fixtures/gtfs-cadiz.snapshot.json --feed-version nap-YYYY-MM-DD`, see docs/RELEASE.md).';
  if (days < 0) {
    return [`GTFS snapshot ${snapshot.feedVersion} expired on ${toIso(last)}: the scheduled fallback no longer answers. ${renew}`];
  }
  if (days < MIN_DAYS_OF_VALIDITY) {
    return [`GTFS snapshot ${snapshot.feedVersion} is valid until ${toIso(last)} (${days} days left, minimum ${MIN_DAYS_OF_VALIDITY}). ${renew}`];
  }
  return [];
}
