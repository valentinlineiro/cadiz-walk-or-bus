import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real Chromium, real service worker, local server only: no wrangler, secrets or external network.
// Proves what reading sw.js cannot: the shell is served Cache-First and /api never goes through it.

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SHELL_FILE = '/web/state.js'; // listed in SHELL_URLS
const BLANK_PAGE = '/e2e-blank'; // a page that does not run the app, only registers the worker

const hits = {};
let apiCalls = 0;
let shellFileOnNetwork = null; // when set, the network answers differently for SHELL_FILE

function startServer() {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    hits[pathname] = (hits[pathname] ?? 0) + 1;
    // Same revalidation behaviour as Workers static assets.
    res.setHeader('Cache-Control', 'max-age=0, must-revalidate');
    if (pathname === '/api') {
      apiCalls += 1;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ arrivals: [], servedByNetwork: apiCalls }));
    }
    if (pathname === BLANK_PAGE) {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<!doctype html><title>blank</title>');
    }
    if (pathname === SHELL_FILE && shellFileOnNetwork !== null) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(shellFileOnNetwork);
    }
    const file = normalize(join(publicDir, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(publicDir)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      res.setHeader('Content-Type', type);
      return res.end(body);
    } catch {
      return res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withControlledPage(run) {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}${BLANK_PAGE}`);
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await run(page);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('shouldServeTheShellFromTheCacheWhenTheNetworkAnswerHasChanged', async () => {
  await withControlledPage(async (page) => {
    const original = await readFile(join(publicDir, SHELL_FILE), 'utf8');
    shellFileOnNetwork = 'export const CHANGED_ON_THE_NETWORK = true;';
    const before = hits[SHELL_FILE];

    const served = await page.evaluate((path) => fetch(path).then((r) => r.text()), SHELL_FILE);

    assert.equal(served, original, 'the stored shell file must win over the changed network answer');
    assert.equal(hits[SHELL_FILE], before, 'a cache hit must not reach the network');
    shellFileOnNetwork = null;
  });
});

test('shouldReachTheServerAndGetItsCurrentAnswerWhenRequestingApiThroughTheWorker', async () => {
  await withControlledPage(async (page) => {
    const first = await page.evaluate(() => fetch('/api?stop=1215').then((r) => r.json()));
    const second = await page.evaluate(() => fetch('/api?stop=1215').then((r) => r.json()));

    assert.deepEqual([first.servedByNetwork, second.servedByNetwork], [apiCalls - 1, apiCalls], 'each call is answered by the server, not replayed');
    const stored = await page.evaluate(async () => {
      const names = await caches.keys();
      const matches = await Promise.all(names.map((n) => caches.open(n).then((c) => c.match('/api?stop=1215'))));
      return matches.filter(Boolean).length;
    });
    assert.equal(stored, 0, '/api must never be stored by the shell cache');
  });
});
