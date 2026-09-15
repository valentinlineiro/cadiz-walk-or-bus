import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://77.224.241.76/urbanos/mobile';
export const DEFAULT_LINES = ['1', '2', '3', '5', '7'];

function hiddenInputs(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

export function extractDestinationName(trayectoText) {
  const parts = trayectoText.split(/\s+A\s+/i);
  if (parts.length >= 2) {
    const rawDest = parts.slice(1).join(' A ').trim();
    // Strip trailing parenthetical notes like (PROL. COLEGIO)
    return rawDest.replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  return trayectoText.trim();
}

export async function fetchLineRoutes(fetchImpl, line) {
  const defaultHtml = await (await fetchImpl(`${BASE}/default.aspx`)).text();
  const h1 = hiddenInputs(defaultHtml);
  for (const k of Object.keys(h1)) if (k.includes('btn') && !k.endsWith('btnSearch')) delete h1[k];
  h1['ctl00$ContentPlaceHolderContenido$btnSearch'] = 'Búsqueda';
  h1['ctl00$ContentPlaceHolderContenido$txtLineNumber'] = line;

  const res1 = await fetchImpl(`${BASE}/default.aspx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(h1),
  });
  const text1 = await res1.text();
  const h2 = hiddenInputs(text1);
  const routeBtnMatch = text1.match(/name="([^"]*btnRoutes[^"]*)"/);
  if (!routeBtnMatch) {
    throw new Error(`No route button found for line ${line}`);
  }
  for (const k of Object.keys(h2)) if (k.includes('btn') && !k.endsWith('btnRoutes')) delete h2[k];
  h2[routeBtnMatch[1]] = 'Trayectos';

  const action1Match = text1.match(/<form[^>]*action="([^"]+)"/);
  if (!action1Match) throw new Error(`Missing form action in line search for ${line}`);
  const action1 = action1Match[1].replaceAll('&amp;', '&');
  const url1 = action1.startsWith('http') ? action1 : `${BASE}/${action1.replace(/^\.\//, '')}`;

  const res2 = await fetchImpl(url1, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(h2),
  });
  const text2 = await res2.text();
  const rows = [...text2.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  if (rows.length === 0) throw new Error(`No trayecto rows found for line ${line}`);

  const directions = {};

  for (const r of rows) {
    const btn = r.match(/name="([^"]*btnBusStops[^"]*)"/)?.[1];
    if (!btn) continue;
    const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 3) continue;
    const code = cells[0];
    const trayectoName = cells[2];

    // Only commercial standard directions: code '1' and '2'
    if (code !== '1' && code !== '2') continue;

    const destKey = extractDestinationName(trayectoName);
    const h3 = hiddenInputs(text2);
    for (const k of Object.keys(h3)) if (k.includes('btnBusStops')) delete h3[k];
    h3[btn] = 'Paradas';

    const action2Match = text2.match(/<form[^>]*action="([^"]+)"/);
    if (!action2Match) throw new Error(`Missing form action in trayectos for line ${line}`);
    const action2 = action2Match[1].replaceAll('&amp;', '&');
    const url2 = action2.startsWith('http') ? action2 : `${BASE}/${action2.replace(/^\.\//, '')}`;

    const res3 = await fetchImpl(url2, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(h3),
    });
    const text3 = await res3.text();
    const stopRows = [...text3.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
    const stopIds = [];

    for (const sr of stopRows) {
      const stopCells = [...sr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
      if (stopCells.length >= 2 && /^\d+$/.test(stopCells[0])) {
        stopIds.push(Number(stopCells[0]));
      }
    }

    if (stopIds.length === 0) {
      throw new Error(`Direction ${destKey} for line ${line} returned 0 stops`);
    }

    directions[destKey] = stopIds;
  }

  return directions;
}

export function validateLines(linesData, knownStops) {
  const knownSet = new Set((knownStops ?? []).map((s) => Number(s.stop || s.number)));

  for (const expectedLine of DEFAULT_LINES) {
    if (!linesData[expectedLine]) {
      throw new Error(`Missing required line ${expectedLine} in lines data`);
    }
  }

  for (const [line, directions] of Object.entries(linesData)) {
    const dirKeys = Object.keys(directions);
    if (dirKeys.length < 2) {
      throw new Error(`Line ${line} has fewer than 2 directions (${dirKeys.length} found)`);
    }

    const seenSequences = new Set();
    for (const [dir, stops] of Object.entries(directions)) {
      if (!stops || !Array.isArray(stops) || stops.length < 2) {
        throw new Error(`Line ${line} direction ${dir} has invalid stops sequence (length: ${stops?.length})`);
      }

      const seqKey = stops.join(',');
      if (seenSequences.has(seqKey)) {
        throw new Error(`Line ${line} has duplicate stop sequence for direction ${dir}`);
      }
      seenSequences.add(seqKey);

      for (const stopId of stops) {
        if (!Number.isInteger(stopId) || stopId <= 0) {
          throw new Error(`Line ${line} direction ${dir} contains non-integer stop ID: ${stopId}`);
        }
        if (knownSet.size > 0 && !knownSet.has(stopId)) {
          throw new Error(`Line ${line} direction ${dir} references stop ID ${stopId} not found in stops.json`);
        }
      }
    }
  }
}

export function buildLinesArtifact(linesData) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'urbanos/mobile',
    lines: linesData,
  };
}

export async function crawlLines(fetchImpl, lineNumbers = DEFAULT_LINES, knownStops = []) {
  const linesData = {};
  for (const line of lineNumbers) {
    linesData[line] = await fetchLineRoutes(fetchImpl, line);
  }
  validateLines(linesData, knownStops);
  return buildLinesArtifact(linesData);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stopsFile = path.resolve('stops.json');
  const knownStops = fs.existsSync(stopsFile) ? JSON.parse(fs.readFileSync(stopsFile, 'utf8')) : [];

  console.log(`Crawling lines [${DEFAULT_LINES.join(', ')}] from upstream...`);
  crawlLines(fetch, DEFAULT_LINES, knownStops)
    .then((artifact) => {
      fs.writeFileSync('lines.json', JSON.stringify(artifact, null, 2) + '\n');
      console.log(`Successfully generated lines.json with ${Object.keys(artifact.lines).length} lines.`);
    })
    .catch((err) => {
      console.error('FAILED to crawl/validate lines:', err.message);
      process.exit(1);
    });
}
