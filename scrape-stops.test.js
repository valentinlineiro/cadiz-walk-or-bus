import test from 'node:test';
import assert from 'node:assert/strict';
import { searchStops } from './scrape-stops.js';

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

test('searchStops posts the query and parses [number, name] rows', async () => {
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
