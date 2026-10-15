// Read-only: does the GTFS feed cover the municipal lines at all?
// Geometry only ranks candidates; "confirmed" needs documentary evidence passed via --evidence
// ({"1": ["M-010"]}). Without it nothing is ever confirmed.
// Usage: node scripts/audit-line-coverage.mjs [--evidence file.json] [--output report.json]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { haversine } from './audit-stops.mjs';

const SAME_STOP_M = 60;
const PLAUSIBLE = 0.6; // share of a municipal line's stops that a single GTFS line passes within SAME_STOP_M
const NONE = 0.15;

export function coverage({ municipal, linesFile, gtfs, evidence = {} }) {
  const coords = new Map(municipal.map((s) => [String(s.stop), s]));
  const gtfsCoords = new Map(gtfs.stops.map((s) => [String(s.stop), s]));
  const gtfsLines = new Map();
  for (const t of gtfs.trips) {
    const g = gtfsLines.get(t.line) ?? { trips: 0, stops: new Set() };
    g.trips += 1;
    t.stopTimes.forEach((x) => g.stops.add(String(x.stop)));
    gtfsLines.set(t.line, g);
  }

  const lines = linesFile.lines ?? linesFile;
  const municipalLines = Object.entries(lines).sort(([a], [b]) => a.localeCompare(b)).map(([line, dirs]) => {
    const ids = [...new Set(Object.values(dirs).flat().map(String))].filter((id) => coords.has(id));
    const ranked = [...gtfsLines.entries()].map(([gl, g]) => {
      const gs = [...g.stops].map((id) => gtfsCoords.get(id)).filter(Boolean);
      const hit = ids.filter((id) => gs.some((p) => haversine(coords.get(id), p) <= SAME_STOP_M)).length;
      return { gtfsLine: gl, trips: g.trips, sharedStops: hit, share: Math.round((100 * hit) / (ids.length || 1)) / 100 };
    }).sort((a, b) => b.share - a.share || a.gtfsLine.localeCompare(b.gtfsLine));
    const best = ranked[0]?.share ?? 0;
    const evidenced = (evidence[line] ?? []).filter((g) => gtfsLines.has(g));
    const verdict = evidenced.length ? 'coverage_confirmed'
      : best < NONE ? 'no_apparent_coverage'
        : best >= PLAUSIBLE ? 'plausible_needs_evidence' : 'indeterminate';
    return { line, stops: ids.length, verdict, evidencedGtfsLines: evidenced, bestCandidates: ranked.slice(0, 3) };
  });

  const verdictByLine = new Map(municipalLines.map((l) => [l.line, l.verdict]));
  const stopLines = new Map();
  for (const [line, dirs] of Object.entries(lines)) {
    for (const id of new Set(Object.values(dirs).flat().map(String))) stopLines.set(id, [...(stopLines.get(id) ?? []), line]);
  }
  const stopVerdicts = {};
  for (const [id, ls] of [...stopLines].sort(([a], [b]) => a.localeCompare(b))) {
    const vs = ls.map((l) => verdictByLine.get(l));
    stopVerdicts[id] = vs.includes('coverage_confirmed') ? 'coverage_confirmed'
      : vs.includes('plausible_needs_evidence') ? 'plausible_needs_evidence'
        : vs.every((v) => v === 'no_apparent_coverage') ? 'no_apparent_coverage' : 'indeterminate';
  }
  const tally = (o) => Object.values(o).reduce((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
  return {
    summary: {
      gtfsLines: gtfsLines.size,
      municipalLines: Object.fromEntries(municipalLines.map((l) => [l.line, l.verdict])),
      municipalStopsByVerdict: tally(stopVerdicts),
    },
    municipalLines,
    gtfsLines: [...gtfsLines].sort(([a], [b]) => a.localeCompare(b)).map(([line, g]) => ({ line, trips: g.trips, stops: g.stops.size })),
    stopVerdicts,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
  const read = (p) => readFileSync(new URL(p, import.meta.url));
  const raw = {
    'stops.json': read('../stops.json'),
    'lines.json': read('../lines.json'),
    'gtfs-cadiz.snapshot.json': read('../public/fixtures/gtfs-cadiz.snapshot.json'),
  };
  const evFile = arg('--evidence') ? readFileSync(arg('--evidence')) : null;
  const report = {
    inputs: {
      ...Object.fromEntries(Object.entries(raw).map(([k, b]) => [k, createHash('sha256').update(b).digest('hex')])),
      ...(evFile ? { evidence: createHash('sha256').update(evFile).digest('hex') } : {}),
    },
    ...coverage({
      municipal: JSON.parse(raw['stops.json']),
      linesFile: JSON.parse(raw['lines.json']),
      gtfs: JSON.parse(raw['gtfs-cadiz.snapshot.json']),
      evidence: evFile ? JSON.parse(evFile) : {},
    }),
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (arg('--output')) writeFileSync(arg('--output'), text); else process.stdout.write(text);
}
