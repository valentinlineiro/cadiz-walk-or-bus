import test from 'node:test';
import assert from 'node:assert/strict';
import { NominatimGeocodingAdapter } from './infrastructure/geocoding/NominatimGeocodingAdapter.js';
import { SearchDestinationsUseCase } from './application/use-cases/SearchDestinationsUseCase.js';
import { GeocodingUnavailableError } from './application/ports/GeocodingPort.js';

// "No results" and "could not ask" are different answers: only the first may read as empty.

const respond = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});
const adapterFor = (fetchImpl) => new NominatimGeocodingAdapter(fetchImpl, { minIntervalMs: 0 });
const hit = [{ lat: '36.5350', lon: '-6.2970', display_name: 'Plaza Mina, Cádiz', name: 'Plaza Mina' }];

test('shouldReturnResultsWhenProviderAnswersWithHits', async () => {
  const results = await adapterFor(respond(200, hit)).search('Plaza Mina');

  assert.equal(results.length, 1);
  assert.equal(results[0].label, 'Plaza Mina');
});

test('shouldReturnEmptyWhenProviderAnswersWithNoHits', async () => {
  assert.deepEqual(await adapterFor(respond(200, [])).search('zzzz qqqq'), []);
});

test('shouldReturnEmptyWhenProxyReportsNotFound', async () => {
  assert.deepEqual(await adapterFor(respond(404, { error: 'upstream 404' })).search('Plaza Mina'), []);
});

test('shouldReturnEmptyWithoutRequestWhenQueryExceedsProxyLimit', async () => {
  let calls = 0;
  const adapter = adapterFor(async () => { calls += 1; return respond(200, hit)(); });

  assert.deepEqual(await adapter.search(`Plaza ${'x'.repeat(100)}`), []);
  assert.equal(calls, 0);
});

for (const status of [400, 429, 500, 502, 503]) {
  test(`shouldRejectSearchWhenProviderAnswersWithStatus${status}`, async () => {
    await assert.rejects(adapterFor(respond(status, { error: 'x' })).search('Plaza Mina'), GeocodingUnavailableError);
  });
}

test('shouldRejectSearchWhenResponseIsNotJson', async () => {
  await assert.rejects(adapterFor(respond(200, new SyntaxError('bad json'))).search('Plaza Mina'), GeocodingUnavailableError);
});

test('shouldRejectSearchWhenResponseIsNotAnArray', async () => {
  await assert.rejects(adapterFor(respond(200, { error: 'busy' })).search('Plaza Mina'), GeocodingUnavailableError);
});

test('shouldKeepTheCauseForDiagnosisWhenNetworkFails', async () => {
  const cause = new Error('offline');
  const error = await adapterFor(async () => { throw cause; }).search('Plaza Mina').catch((e) => e);

  assert.ok(error instanceof GeocodingUnavailableError);
  assert.equal(error.cause, cause);
  assert.doesNotMatch(error.message, /offline|nominatim|http/i);
});

test('shouldAnswerAgainWhenProviderRecoversAfterAFailure', async () => {
  let up = false;
  const adapter = adapterFor(async () => (up ? respond(200, hit)() : respond(503, { error: 'busy' })()));

  await assert.rejects(adapter.search('Plaza Mina'), GeocodingUnavailableError);
  up = true;

  assert.equal((await adapter.search('Plaza Mina')).length, 1);
});

test('shouldReturnNullFromGeocodeWhenProviderIsUnavailable', async () => {
  assert.equal(await adapterFor(respond(503, { error: 'busy' })).geocode('Plaza Mina'), null);
});

test('shouldPropagateUnavailableWhenSearchUseCaseCannotReachTheProvider', async () => {
  const useCase = new SearchDestinationsUseCase(adapterFor(respond(503, { error: 'busy' })));

  await assert.rejects(useCase.execute('Plaza Mina', 1), GeocodingUnavailableError);
});

test('shouldReturnEmptyFromSearchUseCaseWhenProviderHasNoHits', async () => {
  const useCase = new SearchDestinationsUseCase(adapterFor(respond(200, [])));

  assert.deepEqual(await useCase.execute('zzzz qqqq', 1), []);
});
