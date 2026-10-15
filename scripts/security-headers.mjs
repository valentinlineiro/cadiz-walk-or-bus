import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const REQUIRED_NONE = ['object-src', 'base-uri', 'frame-ancestors'];
const POLICY_HEADERS = ['content-security-policy', 'x-content-type-options', 'permissions-policy'];

const sha256Source = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs, body]) => !/\bsrc\s*=/i.test(attrs) && body.trim() !== '')
    .map(([, , body]) => body);
}

function externalProblems(html, label) {
  const problems = [];
  for (const [, attrs] of html.matchAll(/<script\b([^>]*)>/gi)) {
    if (/\bsrc\s*=\s*["']?(https?:)?\/\//i.test(attrs)) problems.push(`${label}: external script ${attrs.trim()}`);
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (/rel\s*=\s*["']?stylesheet/i.test(tag) && /href\s*=\s*["']?(https?:)?\/\//i.test(tag)) {
      problems.push(`${label}: external stylesheet ${tag}`);
    }
  }
  return problems;
}

function parsePolicy(csp) {
  return new Map(
    csp.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map(([name, ...tokens]) => [name.toLowerCase(), tokens]),
  );
}

function policyKey(csp) {
  return [...parsePolicy(csp)].map(([n, t]) => `${n} ${[...t].sort().join(' ')}`).sort().join('; ');
}

// Cloudflare `_headers`: a path line, then indented `Name: value` lines.
function parseHeadersFile(text) {
  const blocks = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      blocks.set(line.trim(), current);
    } else if (current) {
      const i = line.indexOf(':');
      if (i > 0) current.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
  }
  return blocks;
}

function htmlFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .filter((p) => !p.includes('/vendor/'));
}

// `worker` = { mapHtml, headers }: the page the Worker itself serves and the headers it attaches.
export function findSecurityProblems(root = defaultRoot, worker = null) {
  const problems = [];
  const publicDir = join(root, 'public');
  const pages = htmlFiles(publicDir).map((p) => ({ label: p.slice(root.length + 1), html: readFileSync(p, 'utf8') }));
  if (worker) pages.push({ label: 'worker MAP_HTML', html: worker.mapHtml });

  for (const { label, html } of pages) problems.push(...externalProblems(html, label));

  const headersPath = join(publicDir, '_headers');
  if (!existsSync(headersPath)) return [...problems, 'public/_headers is missing: no Content-Security-Policy is served'];
  const block = parseHeadersFile(readFileSync(headersPath, 'utf8')).get('/*');
  const csp = block?.get('content-security-policy');
  if (!csp) return [...problems, 'public/_headers has no Content-Security-Policy for /*'];

  const directives = parsePolicy(csp);
  const scriptSrc = directives.get('script-src');
  const requiredSources = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https://tile.openstreetmap.org'],
    'connect-src': ["'self'"],
    'form-action': ["'self'"],
  };
  for (const [name, required] of Object.entries(requiredSources)) {
    const tokens = directives.get(name);
    if (!tokens) {
      problems.push(`CSP must declare ${name} explicitly`);
      continue;
    }
    for (const token of required) {
      if (!tokens.includes(token)) problems.push(`CSP ${name} must include ${token}`);
    }
  }
  for (const name of REQUIRED_NONE) {
    if (!directives.get(name)?.includes("'none'")) problems.push(`CSP must declare ${name} 'none'`);
  }
  for (const token of ["'unsafe-inline'", "'unsafe-eval'"]) {
    if (scriptSrc?.includes(token)) problems.push(`CSP script-src must not allow ${token}`);
  }
  if (block.get('x-content-type-options')?.toLowerCase() !== 'nosniff') problems.push('X-Content-Type-Options: nosniff is required');
  if (!/^geolocation=\(self\)$/.test(block.get('permissions-policy') ?? '')) problems.push('Permissions-Policy: geolocation=(self) is required');

  const allowed = new Set((scriptSrc ?? []).filter((t) => t.startsWith("'sha256-")));
  const seen = new Set();
  for (const { label, html } of pages) {
    for (const body of inlineScripts(html)) {
      const source = sha256Source(body);
      seen.add(source);
      if (!allowed.has(source)) problems.push(`${label}: inline script ${source} is not allowed by script-src (update public/_headers)`);
    }
  }
  for (const source of allowed) {
    if (!seen.has(source)) problems.push(`CSP script-src hash ${source} matches no inline script`);
  }

  if (worker) {
    const wcsp = worker.headers?.['content-security-policy'];
    if (!wcsp || policyKey(wcsp) !== policyKey(csp)) {
      problems.push('worker Content-Security-Policy differs from public/_headers');
    }
    if (!worker.headers?.['x-content-type-options'] || worker.headers['x-content-type-options'].toLowerCase() !== 'nosniff') {
      problems.push('worker response must set X-Content-Type-Options: nosniff');
    }
    if (!/^geolocation=\(self\)$/.test(worker.headers?.['permissions-policy'] ?? '')) {
      problems.push('worker response must set Permissions-Policy: geolocation=(self)');
    }
    for (const name of POLICY_HEADERS.slice(1)) {
      if ((worker.headers?.[name] ?? '') !== (block.get(name) ?? '')) problems.push(`worker ${name} differs from public/_headers`);
    }
  }
  return problems;
}
