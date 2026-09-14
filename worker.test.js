import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

test('GET /api returns parsed arrivals with mocked upstream', async () => {
  const html = `<table><tbody><tr><td>1</td><td>CORTADURA</td><td>3min</td></tr></tbody></table>`;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  const res = await worker.fetch(new Request('http://x/api?stop=1106&route=110001'));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { arrivals: [{ line: '1', destination: 'CORTADURA', minutes: 3 }] });
});

test('GET / serves HTML with favorites UI', async () => {
  const res = await worker.fetch(new Request('http://x/'));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /localStorage/);
  assert.match(body, /walkMinutes/);
});

test('GET /api proxies upstream failure as 502', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const res = await worker.fetch(new Request('http://x/api?stop=1&route=2'));
  assert.equal(res.status, 502);
});

test('GET /api without stop/route returns 400', async () => {
  const res = await worker.fetch(new Request('http://x/api?stop=1'));
  assert.equal(res.status, 400);
});
