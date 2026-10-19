#!/usr/bin/env node
/**
 * Raise the LLM provider retry budget in MiniMax Code.
 *
 * The problem
 * -----------
 * When the model provider rate-limits a request — the `The model provider is
 * rate limiting requests. Code: 50150` error — MiniMax Code retries the
 * request itself, but the budget is a hardcoded constant:
 *
 *     {maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30000, maxRetryElapsedMs: 120000}
 *
 * Five retries means six attempts over about ninety seconds, then the turn
 * dies. A provider that is throttling for a few minutes is a common, and
 * entirely transient, condition.
 *
 * There is no way to configure this. The policy is applied by
 * `Gpn(t.policy)`, which merges over the constant, but `t.policy` never
 * arrives: the only caller that supplies `resolveLlmRetry` hands back an
 * observer and nothing else, and there is no config key or environment
 * variable for it anywhere in the bundle. The constant is the only lever.
 *
 * The fix
 * -------
 * Patch the constant to the same policy the image plugins use: fifteen
 * retries, each a little later than the last.
 *
 *     {maxRetries: 15, baseDelayMs: 1500, maxDelayMs: 30000, maxRetryElapsedMs: 900000}
 *
 * That is sixteen attempts spread over roughly six minutes, with a fifteen
 * minute ceiling in case a server asks for a long `Retry-After`.
 *
 * This is a policy change to a third-party install, not a bug fix. It is
 * reverted by `mcode update`, so re-run this script afterwards. The original
 * chunk is kept alongside as `<chunk>.orig.bak`.
 *
 *   node scripts/apply-mcode-llm-retry-policy.mjs [--check] [--revert]
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** MiniMax Code's built-in default. */
const DEFAULT_POLICY = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxRetryElapsedMs: 120000,
};

/** The policy this script installs — the same shape the image plugins use. */
const PATCHED_POLICY = {
  maxRetries: 15,
  baseDelayMs: 1500,
  maxDelayMs: 30000,
  maxRetryElapsedMs: 900000,
};

const KEYS = ['maxRetries', 'baseDelayMs', 'maxDelayMs', 'maxRetryElapsedMs'];

const checkOnly = process.argv.includes('--check');
const revert = process.argv.includes('--revert');

/** Where mcode may be installed. */
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

/**
 * Locate the policy literal.
 *
 * The variable holding it is minified and its name changes between releases,
 * so the object is matched by its property names instead. All four keys have
 * to be present, which is specific enough to avoid matching anything else.
 */
function findPolicy(source) {
  const results = [];
  const keyPattern = /maxRetries\s*:\s*(\d+)/g;
  let match;
  while ((match = keyPattern.exec(source)) !== null) {
    // The object literal opens *before* the key, so walk back to it. The
    // innermost enclosing brace is the one that holds the policy.
    let start = -1;
    let depth = 0;
    for (let i = match.index - 1; i >= 0; i -= 1) {
      const ch = source[i];
      if (ch === '}') depth += 1;
      else if (ch === '{') {
        if (depth === 0) {
          start = i;
          break;
        }
        depth -= 1;
      }
    }
    if (start < 0) continue;

    // Then walk forward to the matching close brace.
    let end = -1;
    depth = 0;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;

    const body = source.slice(start, end + 1);
    if (!KEYS.every((key) => new RegExp(`${key}\\s*:`).test(body))) continue;

    const values = {};
    for (const key of KEYS) {
      // The minifier writes small numbers in scientific notation: 1e3, 12e4.
      const found = body.match(new RegExp(`${key}\\s*:\\s*(\\d+(?:e\\d+)?)`));
      values[key] = found ? Number(found[1]) : null;
    }
    results.push({ start, end: end + 1, body, values });
  }
  return results;
}

function formatPolicy(policy) {
  return `{${KEYS.map((key) => `${key}:${policy[key]}`).join(',')}}`;
}

function samePolicy(a, b) {
  return KEYS.every((key) => a[key] === b[key]);
}

const packageRoot = findPackageRoot();
if (!packageRoot) {
  console.error(
    'Could not locate @minimax-ai/code.\n' +
      'Set MCODE_PACKAGE_ROOT to the package directory and try again.',
  );
  process.exit(1);
}

const chunksDir = join(packageRoot, 'chunks');
const candidates = readdirSync(chunksDir).filter((file) => file.endsWith('.js'));

let found = null;
for (const file of candidates) {
  const path = join(chunksDir, file);
  const source = readFileSync(path, 'utf8');
  if (!source.includes('maxRetryElapsedMs')) continue;
  const matches = findPolicy(source);
  if (matches.length === 1) {
    found = { path, source, match: matches[0] };
    break;
  }
  if (matches.length > 1) {
    console.error(`ABORT: ${path} contains ${matches.length} policy literals.`);
    process.exit(1);
  }
}

if (!found) {
  console.error(
    'Could not locate the LLM retry policy in the mcode bundle.\n' +
      'Either the version changed the shape of the constant, or it moved to a\n' +
      'different file. Search the bundle for "maxRetryElapsedMs".',
  );
  process.exit(1);
}

const current = found.match.values;
const isPatched = samePolicy(current, PATCHED_POLICY);
const isDefault = samePolicy(current, DEFAULT_POLICY);

if (checkOnly) {
  if (isPatched) {
    console.log(`OK  retry policy is raised: ${formatPolicy(current)}`);
    console.log(`    ${found.path}`);
    process.exit(0);
  }
  console.log(`BAD retry policy is still the default: ${formatPolicy(current)}`);
  console.log(`    ${found.path}`);
  process.exit(1);
}

if (revert) {
  if (isDefault) {
    console.log(`already at MiniMax Code's default: ${formatPolicy(current)}`);
    process.exit(0);
  }
  const updated =
    found.source.slice(0, found.match.start) +
    formatPolicy(DEFAULT_POLICY) +
    found.source.slice(found.match.end);
  writeFileSync(found.path, updated);
  console.log(`reverted retry policy to: ${formatPolicy(DEFAULT_POLICY)}`);
  console.log(`  ${found.path}`);
  process.exit(0);
}

if (isPatched) {
  console.log(`already patched: ${formatPolicy(current)}`);
  console.log(`  ${found.path}`);
  process.exit(0);
}

if (!isDefault) {
  console.error(
    `ABORT: the bundle holds a policy this script does not recognise: ${formatPolicy(current)}\n` +
      'Refusing to overwrite it. Check whether a newer version changed the default.',
  );
  process.exit(1);
}

// Keep the original chunk so a revert is always possible.
const backup = `${found.path}.orig.bak`;
if (!existsSync(backup)) {
  copyFileSync(found.path, backup);
  console.log(`backed up the original chunk: ${backup}`);
}

const updated =
  found.source.slice(0, found.match.start) +
  formatPolicy(PATCHED_POLICY) +
  found.source.slice(found.match.end);
writeFileSync(found.path, updated);

console.log(`patched retry policy: ${formatPolicy(DEFAULT_POLICY)} -> ${formatPolicy(PATCHED_POLICY)}`);
console.log(`  ${found.path}`);
console.log('');
console.log('Sixteen attempts over roughly six minutes, instead of six over ninety seconds.');
console.log('Re-run this script after `mcode update` — the bundle is replaced wholesale there.');
console.log('Revert with: node scripts/apply-mcode-llm-retry-policy.mjs --revert');
