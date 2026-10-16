import test from 'node:test';
import assert from 'node:assert/strict';
import { searchStops, resolveIds, crawl, geocode } from './scrape-stops.js';

const FORM_HTML = `<form action="./default.aspx"><input type="hidden" name="__VIEWSTATE" value="VS1" />
<input type="hidden" name="__VIEWSTATEGENERATOR" value="VG1" />
<input type="hidden" name="__EVENTVALIDATION" value="EV1" /></form>`;
const RESULT_HTML = `<form action="./search.aspx?t1=CORTADURA&amp;t2=&amp;t3=">
<table id="ctl00_ContentPlaceHolderContenido_RepeaterBusStops">
<tr><td>1114</td><td>CORTADURA</td><td></td></tr>
<tr><td>1901</td><td>CORTADURA</td><td></td></tr>
</table>
<input name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl01$btnTimes" value="" />
<input name="__VIEWSTATE" value="VS2" /></form>`;

test('shouldPostTheQueryAndParseNumberAndNameRowsWhenSearchingStops', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([url, opts?.method || 'GET', String(opts?.body || '')]);
    return { ok: true, text: async () => (calls.length === 1 ? FORM_HTML : RESULT_HTML) };
  };
  const rows = await searchStops(fetchImpl, 'CORTADURA');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].number, '1114');
  assert.equal(rows[0].name, 'CORTADURA');
  assert.match(calls[1][2], /txtBusStopName=CORTADURA/);
  assert.match(calls[1][2], /btnSearch/);
  assert.ok(rows[0].detailAction.includes('search.aspx?t1=CORTADURA'));
});

const FORM_HTML_WITH_4_ROWS = `<form action="./search.aspx?t1=CORTADURA&amp;t2=&amp;t3=">
<table class="table" style="width: 100%;">
<tr><td>1113</td><td>CORTADURA</td><td><input type="submit" name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl01$btnTimes" value="Tiempos" /></td></tr>
<tr><td>1114</td><td>CORTADURA</td><td><input type="submit" name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl02$btnTimes" value="Tiempos" /></td></tr>
<tr><td>1901</td><td>CORTADURA</td><td><input type="submit" name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl03$btnTimes" value="Tiempos" /></td></tr>
<tr><td>9905</td><td>CENTRO EDUCATIVO CORTADURA</td><td><input type="submit" name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl04$btnTimes" value="Tiempos" /></td></tr>
</table>
<input name="__VIEWSTATE" value="VS2" /></form>`;

test('shouldParseEveryStopRowAndAttachItsIndexWhenSearchingStops', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => FORM_HTML_WITH_4_ROWS });
  const rows = await searchStops(fetchImpl, 'CORTADURA');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2, 3]);
});

test('shouldPostTheRowIndexedButtonAndReadTheStopFromTheRefreshLinkWhenResolvingIds', async () => {
  const row = {
    index: 1,
    detailAction: './search.aspx?t1=CORTADURA&t2=&t3=',
    detailFields: {
      __VIEWSTATE: 'VS2',
      'ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl01$btnTimes': '',
      'ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl02$btnTimes': '',
    },
  };
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(opts?.body || '');
    return { ok: true, text: async () => '<a href="panel.aspx?previous=x&amp;t1=CORTADURA&amp;stop=9905&amp;t3=">Horarios</a>' };
  };
  assert.deepEqual(await resolveIds(fetchImpl, row), { stop: '9905' });
  assert.match(decodeURIComponent(String(calls[0])), /ctl02\$btnTimes/);
  assert.doesNotMatch(String(calls[0]), /__EVENTTARGET/);
});

test('shouldDedupeStopsAndDropRowsWithoutCoordsWhenCrawlingAcrossQueries', async () => {
  const fetchImpl = async (url, opts) => {
    const body = String(opts?.body ?? '');
    if (opts?.method === 'POST' && body.includes('btnSearch')) {
      return { ok: true, text: async () => `<form action="./search.aspx?t1=X&t2=&t3="><table id="ctl00_ContentPlaceHolderContenido_RepeaterBusStops"><tr><td>1114</td><td>CORTADURA</td><td></td></tr></table><input name="ctl00$ContentPlaceHolderContenido$RepeaterBusStops$ctl01$btnTimes" value=""/><input name="__VIEWSTATE" value="V"/></form>` };
    }
    if (url.includes('nominatim')) {
      return { ok: true, json: async () => [{ lat: '36.5001', lon: '-6.2721' }] };
    }
    return { ok: true, text: async () => 'panel.aspx?stop=9905&t3=' };
  };
  const rows = await crawl(fetchImpl, ['CORTADURA', 'CORTADURA']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { name: 'CORTADURA', number: '1114', stop: '9905', lat: 36.5001, lon: -6.2721 });
});

test('shouldBoundQueriesToCadizAndDropOutOfBboxHitsWhenGeocoding', async () => {
  let url;
  const inBox = async (u) => { url = u; return { ok: true, json: async () => [{ lat: '36.5001', lon: '-6.2721' }] }; };
  assert.deepEqual(await geocode(inBox, 'CORTADURA'), { lat: 36.5001, lon: -6.2721 });
  assert.match(url, /viewbox=-6\.35,36\.60,-6\.20,36\.40&bounded=1/);
  const algeciras = async () => ({ ok: true, json: async () => [{ lat: '36.13', lon: '-5.45' }] });
  assert.equal(await geocode(algeciras, 'ALGECIRAS'), null);
});
