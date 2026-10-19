#!/usr/bin/env node
/**
 * Test the patched provider retry classifier in the mcode bundle.
 *
 * `scripts/apply-mcode-llm-retry-policy.mjs` rewrites the classifier that
 * decides whether a provider error is worth retrying. This script pulls that
 * classifier — and the helpers it depends on — straight out of the live bundle
 * and runs it against realistic error facts, so the behaviour that is actually
 * installed is what gets tested.
 *
 * The managed provider path cannot be exercised with a local stub: MiniMax
 * Code marks BYOK providers as "retry every error", so a custom provider
 * never reaches the classifier. Testing the shipped code directly is the only
 * way to cover the managed path.
 *
 *   node scripts/verify-mcode-retry-classifier.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PACKAGE_ROOTS = [
  process.env.MCODE_PACKAGE_ROOT,
  join(homedir(), '.npm-global', 'lib', 'node_modules'),
  join(homedir(), '.local', 'lib', 'node_modules'),
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
].filter(Boolean);

function findPackageRoot() {
  for (const root of PACKAGE_ROOTS) {
    const candidate = join(root, '@minimax-ai', 'code');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/** Pull a minified function out of the bundle by name. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull a `var x=...` binding out of the bundle. */
function extractBinding(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`could not find ${label} in the bundle`);
  return match[0];
}

const packageRoot = findPackageRoot();
if (!packageRoot) {
  console.error('Could not locate @minimax-ai/code.');
  process.exit(1);
}

const chunksDir = join(packageRoot, 'chunks');
let source = null;
for (const file of readdirSync(chunksDir).filter((f) => f.endsWith('.js'))) {
  const candidate = readFileSync(join(chunksDir, file), 'utf8');
  if (candidate.includes('USAGE_LIMIT_EXCEEDED') && candidate.includes('maxRetryElapsedMs')) {
    source = candidate;
    break;
  }
}
if (!source) {
  console.error('Could not locate the classifier in the mcode bundle.');
  process.exit(1);
}

const parts = {
  Ir: extractBinding(source, /var inn=\{[^}]*\},Ir=inn;/, 'the Ir enum'),
  Ktn: extractBinding(source, /var Wtn=\[[^\]]*\],Ktn=new Set\(Wtn\);/, 'the Ktn set'),
  dO: extractFunction(source, 'dO'),
  pO: extractFunction(source, 'pO'),
  g_: extractFunction(source, 'g_'),
  kqe: extractFunction(source, 'kqe'),
  hO: extractFunction(source, 'hO'),
  xqe: extractFunction(source, 'xqe'),
  enn: extractFunction(source, 'enn'),
  yqe: extractBinding(source, /yqe=\(\)=>\(\{[^}]*\}\)/, 'the yqe facts factory'),
};
for (const [name, value] of Object.entries(parts)) {
  if (!value) {
    console.error(`could not extract ${name} from the bundle`);
    process.exit(1);
  }
}

const sandbox = `
${parts.Ir}
${parts.Ktn}
var bqe=2066;
${parts.dO}
${parts.pO}
${parts.g_}
${parts.kqe}
${parts.hO}
${parts.xqe}
${parts.enn}
var ${parts.yqe};
return { xqe, hO, enn, yqe, Ir };
`;

const api = new Function(sandbox)();

/** Build the facts the way the runtime does, then classify. */
function classify({ upstreamStatusCode, httpStatus, providerMessageCode, explicitAbort, signals = [] }) {
  const facts = api.yqe();
  if (explicitAbort) facts.explicitAbort = true;
  if (upstreamStatusCode !== undefined) facts.upstreamStatusCode = upstreamStatusCode;
  if (httpStatus !== undefined) facts.httpStatus = httpStatus;
  if (providerMessageCode !== undefined) facts.providerMessageCode = providerMessageCode;
  for (const signal of signals) facts.signals.add(signal);
  api.enn(facts, facts.signals);
  return api.xqe({ facts, sanitizedMessage: '' });
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

const expect = (label, input, retryable, reason) => {
  const outcome = classify(input);
  check(
    label,
    outcome.retryable === retryable,
    `retryable=${outcome.retryable} reason=${outcome.reason}`,
  );
  if (reason && outcome.reason !== reason) {
    check(`${label} — reason`, false, `expected ${reason}, got ${outcome.reason}`);
  }
};

// --- Retried: the cases that used to be terminal -----------------------------
expect(
  'a spent quota (upstream 2056) is retried',
  { upstreamStatusCode: 2056 },
  true,
  'usage_limit',
);
expect(
  'a spent quota (upstream 2067) is retried',
  { upstreamStatusCode: 2067 },
  true,
  'usage_limit',
);
expect('exhausted credits (http 402) is retried', { httpStatus: 402 }, true, 'credits_exhausted');
expect(
  'exhausted credits (message code 1008) is retried',
  { providerMessageCode: 1008, upstreamStatusCode: 1400010161 },
  true,
  'credits_exhausted',
);

// --- Retried: the cases that were already retryable -------------------------
expect('a token-per-minute limit is retried', { httpStatus: 429, signals: ['tpm_rate_limit'] }, true);
expect('a plain rate limit is retried', { httpStatus: 429 }, true);
expect('a server error is retried', { httpStatus: 503 }, true);

// --- Terminal: the cases that must stay terminal ---------------------------
expect('an auth failure is not retried', { httpStatus: 401 }, false, 'auth');
expect('a forbidden response is not retried', { httpStatus: 403 }, false, 'auth');
expect('a content filter is not retried', { signals: ['content_filter'] }, false);
expect('a refusal is not retried', { signals: ['refusal'] }, false);
expect('an explicit abort is not retried', { explicitAbort: true, httpStatus: 429 }, false);
expect('a bad request is not retried', { httpStatus: 400 }, false, 'bad_request');
expect('a not-found is not retried', { httpStatus: 404 }, false, 'not_found');

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
