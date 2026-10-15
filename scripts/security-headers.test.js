import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSecurityProblems } from './security-headers.mjs';

const INLINE = "import { initUI } from './web/ui.js';\ninitUI();\n";
const hashOf = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

const policy = (overrides = {}) => {
  const directives = {
    'default-src': "'self'",
    'script-src': `'self' ${hashOf(INLINE)}`,
    'style-src': "'self' 'unsafe-inline'",
    'img-src': "'self' https://tile.openstreetmap.org",
    'connect-src': "'self'",
    'object-src': "'none'",
    'base-uri': "'none'",
    'frame-ancestors': "'none'",
    ...overrides,
  };
  return Object.entries(directives).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`).join('; ');
};

const headersFile = (csp, extra = ['X-Content-Type-Options: nosniff', 'Permissions-Policy: geolocation=(self)']) =>
  ['/*', `  Content-Security-Policy: ${csp}`, ...extra.map((l) => `  ${l}`)].join('\n') + '\n';

const page = (scripts = `<script type="module">${INLINE}</script>`) =>
  `<!doctype html><html><head><link rel="stylesheet" href="/vendor/leaflet/leaflet.css"></head><body>${scripts}</body></html>`;

function project(t, { html = page(), headers = headersFile(policy()) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sec-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'public'), { recursive: true });
  writeFileSync(join(root, 'public/index.html'), html);
  if (headers !== null) writeFileSync(join(root, 'public/_headers'), headers);
  return root;
}

const problems = (root, worker) => findSecurityProblems(root, worker);

test('shouldReportNothingWhenHeadersAndPagesAreConsistent', (t) => {
  assert.deepEqual(problems(project(t)), []);
});

test('shouldReportExternalScriptWhenPageLoadsARemoteScript', (t) => {
  const root = project(t, { html: page('<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>') });
  assert.ok(problems(root).some((p) => /external script/.test(p)));
});

test('shouldReportExternalStylesheetWhenPageLoadsARemoteStylesheet', (t) => {
  const html = '<link rel="stylesheet" href="https://unpkg.com/leaflet.css"><script type="module">' + INLINE + '</script>';
  assert.ok(problems(project(t, { html })).some((p) => /external stylesheet/.test(p)));
});

test('shouldReportMissingHeadersFileWhenPublicHasNoHeaders', (t) => {
  assert.ok(problems(project(t, { headers: null })).some((p) => /_headers/.test(p)));
});

test('shouldReportUnsafeInlineWhenScriptSrcAllowsIt', (t) => {
  const csp = policy({ 'script-src': `'self' 'unsafe-inline' ${hashOf(INLINE)}` });
  assert.ok(problems(project(t, { headers: headersFile(csp) })).some((p) => /unsafe-inline/.test(p)));
});

test('shouldReportUnsafeEvalWhenScriptSrcAllowsIt', (t) => {
  const csp = policy({ 'script-src': `'self' 'unsafe-eval' ${hashOf(INLINE)}` });
  assert.ok(problems(project(t, { headers: headersFile(csp) })).some((p) => /unsafe-eval/.test(p)));
});

test('shouldReportMissingHashWhenInlineScriptIsNotAllowlisted', (t) => {
  const root = project(t, { html: page('<script type="module">initUI();</script>') });
  assert.ok(problems(root).some((p) => /not allowed by script-src/.test(p)));
});

test('shouldReportStaleHashWhenNoInlineScriptMatches', (t) => {
  const root = project(t, { html: page('') });
  assert.ok(problems(root).some((p) => /matches no inline script/.test(p)));
});

test('shouldReportMissingDirectiveWhenFrameAncestorsIsAbsent', (t) => {
  const csp = policy({ 'frame-ancestors': null });
  assert.ok(problems(project(t, { headers: headersFile(csp) })).some((p) => /frame-ancestors/.test(p)));
});

test('shouldReportMissingNosniffWhenHeaderIsAbsent', (t) => {
  const headers = headersFile(policy(), ['Permissions-Policy: geolocation=(self)']);
  assert.ok(problems(project(t, { headers })).some((p) => /X-Content-Type-Options/.test(p)));
});

test('shouldReportWorkerPageWhenItLoadsAnExternalScript', (t) => {
  const worker = { mapHtml: page('<script src="https://evil.example/x.js"></script>'), headers: { 'content-security-policy': policy() } };
  assert.ok(problems(project(t), worker).some((p) => /worker MAP_HTML.*external script/.test(p)));
});

test('shouldReportDriftWhenWorkerPolicyDiffersFromHeadersFile', (t) => {
  const worker = { mapHtml: page(), headers: { 'content-security-policy': policy({ 'img-src': '*' }) } };
  assert.ok(problems(project(t), worker).some((p) => /differs from public\/_headers/.test(p)));
});


test('shouldRequireSelfForSameOriginScripts', (t) => {
  const csp = policy({ 'script-src': hashOf(INLINE) });
  assert.ok(problems(project(t, { headers: headersFile(csp) })).some((p) => /script-src must include 'self'/.test(p)));
});

test('shouldRequireConnectSrcAndFormAction', (t) => {
  const csp = policy({ 'connect-src': null, 'form-action': null });
  const found = problems(project(t, { headers: headersFile(csp) }));
  assert.ok(found.some((p) => /connect-src explicitly/.test(p)));
  assert.ok(found.some((p) => /form-action explicitly/.test(p)));
});

test('shouldRequireDataImageSourceForLeafletPlaceholder', (t) => {
  const csp = policy({ 'img-src': "'self' https://tile.openstreetmap.org" });
  assert.ok(problems(project(t, { headers: headersFile(csp) })).some((p) => /img-src must include data:/.test(p)));
});

test('shouldRequireStyleSrcExplicitly', (t) => {
  const csp = policy({ 'style-src': null });
  assert.ok(problems(project(t, { headers: headersFile(csp) })).some((p) => /style-src explicitly/.test(p)));
});

test('shouldRequireBaseUriAndFrameAncestorsNone', (t) => {
  const csp = policy({ 'base-uri': null, 'frame-ancestors': null });
  const found = problems(project(t, { headers: headersFile(csp) }));
  assert.ok(found.some((p) => /base-uri 'none'/.test(p)));
  assert.ok(found.some((p) => /frame-ancestors 'none'/.test(p)));
});

test('shouldReportMissingWorkerSecurityHeaders', (t) => {
  const worker = {
    mapHtml: page(),
    headers: {
      'content-security-policy': policy(),
      'x-content-type-options': 'nosniff',
    },
  };
  assert.ok(problems(project(t), worker).some((p) => /worker response must set Permissions-Policy/.test(p)));
});

test('shouldAcceptWorkerPageWhenPolicyAndScriptsMatch', (t) => {
  const headers = {
    'content-security-policy': policy(),
    'x-content-type-options': 'nosniff',
    'permissions-policy': 'geolocation=(self)',
  };
  assert.deepEqual(problems(project(t), { mapHtml: page(), headers }), []);
});
