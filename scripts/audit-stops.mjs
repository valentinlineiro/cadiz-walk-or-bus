// Read-only audit: municipal stops (stops.json + lines.json) vs the GTFS snapshot.
// Never writes production data and never asserts an equivalence: it only ranks candidates.
// Usage: node scripts/audit-stops.mjs [--output report.json]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NEAR_M = 50;
const SEARCH_M = 150;

const haversine = (a, b) => {
  const r = Math.PI / 180;
  const d = Math.sin(((b.lat - a.lat) * r) / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(d));
};
const tokens = (name) => new Set(
  String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !['avda', 'avenida', 'plaza', 'pza', 'calle', 'del', 'las', 'los'].includes(t)),
);
const similarity = (a, b) => {
  const [x, y] = [tokens(a), tokens(b)];
  const inter = [...x].filter((t) => y.has(t)).length;
  return x.size + y.size === 0 ? 0 : Math.round((100 * inter) / (x.size + y.size - inter || 1)) / 100;
};

export function audit({ municipal, linesFile, gtfs }) {
  const byId = new Map();
  const duplicates = [];
  for (const s of municipal) {
    const id = String(s.stop);
    const prev = byId.get(id);
    if (!prev) byId.set(id, s);
    else if (prev.name !== s.name || prev.lat !== s.lat || prev.lon !== s.lon) duplicates.push(id);
  }
  const stops = [...byId.values()].sort((a, b) => String(a.stop).localeCompare(String(b.stop)));

  const lines = linesFile.lines ?? linesFile;
  const served = new Set();
  const lineIssues = [];
  for (const [line, dirs] of Object.entries(lines)) {
    for (const [dir, seq] of Object.entries(dirs)) {
      const ids = seq.map(String);
      if (ids.length < 2) lineIssues.push({ line, dir, issue: 'short_sequence' });
      ids.forEach((id, i) => {
        served.add(id);
        if (!byId.has(id)) lineIssues.push({ line, dir, stop: id, issue: 'unknown_stop' });
        if (id === ids[i - 1]) lineIssues.push({ line, dir, stop: id, issue: 'consecutive_duplicate' });
      });
    }
  }
  const unserved = stops.map((s) => String(s.stop)).filter((id) => !served.has(id));

  const gtfsIds = new Set(gtfs.stops.map((s) => String(s.stop)));
  const rows = stops.map((s) => {
    const candidates = gtfs.stops
      .map((g) => ({ gtfsStop: String(g.stop), name: g.name, meters: Math.round(haversine(s, g)), nameSimilarity: similarity(s.name, g.name) }))
      .filter((c) => c.meters <= SEARCH_M)
      .sort((a, b) => a.meters - b.meters || a.gtfsStop.localeCompare(b.gtfsStop))
      .slice(0, 3);
    const close = candidates.filter((c) => c.meters <= 100).length;
    const bucket = candidates.length === 0 ? 'no_match_found'
      : close > 1 ? 'ambiguous'
        : candidates[0].meters <= NEAR_M ? 'candidate' : 'weak_candidate';
    return { stop: String(s.stop), name: s.name, bucket, sameIdInGtfs: gtfsIds.has(String(s.stop)), candidates };
  });
  const count = (key) => rows.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] ?? 0) + 1 }), {});
  return {
    summary: {
      municipalStops: stops.length,
      gtfsStops: gtfs.stops.length,
      sameIdInGtfs: rows.filter((r) => r.sameIdInGtfs).length,
      buckets: count('bucket'),
      duplicateIdsWithDifferingData: duplicates.length,
      lineIssues: lineIssues.length,
      stopsServedByNoLine: unserved.length,
    },
    duplicateIdsWithDifferingData: duplicates,
    lineIssues,
    stopsServedByNoLine: unserved,
    stops: rows,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (p) => readFileSync(new URL(p, import.meta.url));
  const files = {
    'stops.json': '../stops.json',
    'lines.json': '../lines.json',
    'gtfs-cadiz.snapshot.json': '../public/fixtures/gtfs-cadiz.snapshot.json',
  };
  const raw = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, read(p)]));
  const report = {
    inputs: Object.fromEntries(Object.entries(raw).map(([k, b]) => [k, createHash('sha256').update(b).digest('hex')])),
    ...audit({
      municipal: JSON.parse(raw['stops.json']),
      linesFile: JSON.parse(raw['lines.json']),
      gtfs: JSON.parse(raw['gtfs-cadiz.snapshot.json']),
    }),
  };
  const out = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, text); else process.stdout.write(text);
}
