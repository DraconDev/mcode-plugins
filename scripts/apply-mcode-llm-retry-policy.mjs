#!/usr/bin/env node
/**
 * Make MiniMax Code's provider retries persistent.
 *
 * Two patches, both to the mcode bundle, both reversible.
 *
 * 1. The retry budget
 * -------------------
 * When the model provider rate-limits a request, MiniMax Code retries it
 * itself, but the budget is a hardcoded constant:
 *
 *     {maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30000, maxRetryElapsedMs: 120000}
 *
 * Five retries means six attempts over about twenty seconds of waiting, then
 * the turn dies. There is no way to configure this. The policy is applied by
 * `Gpn(t.policy)`, which merges over the constant, but `t.policy` never
 * arrives: the only caller that supplies `resolveLlmRetry` hands back an
 * observer and nothing else, and there is no config key or environment
 * variable for it anywhere in the bundle. The constant is the only lever.
 *
 * It becomes:
 *
 *     {maxRetries: 200, baseDelayMs: 1500, maxDelayMs: 300000, maxRetryElapsedMs: 21600000}
 *
 * The first few attempts stay close together, so a rate limit that clears in
 * seconds is caught almost immediately. The delay then doubles up to a
 * five-minute cap, and the loop keeps going for six hours — long enough to
 * outlast a quota that takes hours to reset. The attempt count is a backstop;
 * the wall clock is what actually binds.
 *
 * 2. The retryable-error classifier
 * ----------------------------------
 * The provider's own protocol codes are classified by `xqe`, and several of
 * them are hardcoded as terminal:
 *
 *     42212  USAGE_LIMIT_EXCEEDED    a quota that is spent
 *     50110  LLM_CREDITS_EXHAUSTED   credits that are spent
 *
 * A terminal error ends the turn immediately: no retry, no backoff, nothing.
 * That is wrong for a quota that resets on a timer. A plain 5xx is terminal
 * too, which is stranger still — MiniMax Code retries 429 and 529 but gives up
 * on 500, 502 and 504.
 *
 * The patch moves all three behind the retryable path, where the budget above
 * applies:
 *
 *   - upstream status 2056 or 2067  -> 42212, now retried
 *   - upstream status 402, or provider message code 1008 -> 50110, now retried
 *   - any 5xx status -> now retried
 *
 * Everything else is left exactly as it was. An authentication failure
 * (401/403) stays terminal — a bad credential will not fix itself, and
 * retrying it for six hours is pointless. So do a content filter, a refusal,
 * a bad request, and an explicit abort by the user.
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

/** The policy this script installs. */
const PATCHED_POLICY = {
  maxRetries: 200,
  baseDelayMs: 1500,
  maxDelayMs: 300000,
  maxRetryElapsedMs: 21600000,
};

/**
 * Policies this script is willing to overwrite.
 *
 * The default is MiniMax Code's. The second is the shorter window this
 * script installed before the budget was widened to cover a multi-hour quota
 * reset, so the script can move between them without a manual revert.
 */
const KNOWN_POLICIES = [
  DEFAULT_POLICY,
  { maxRetries: 15, baseDelayMs: 1500, maxDelayMs: 30000, maxRetryElapsedMs: 900000 },
  PATCHED_POLICY,
];

const KEYS = ['maxRetries', 'baseDelayMs', 'maxDelayMs', 'maxRetryElapsedMs'];

/**
 * The terminal-error guard in the retry classifier.
 *
 * Matched as a regex because the minifier writes `!1` for false, and that can
 * change between releases. The property and signal names are not minified, so
 * they are the stable part.
 */
const QUOTA_GUARD = new RegExp(
  'if\\(t\\.explicitAbort\\|\\|t\\.signals\\.has\\("usage_limit"\\)\\|\\|t\\.signals\\.has\\("credits_exhausted"\\)' +
    '\\|\\|t\\.signals\\.has\\("content_filter"\\)\\|\\|t\\.signals\\.has\\("refusal"\\)' +
    '\\|\\|n==="abort"\\|\\|n==="usage_limit"\\|\\|n==="credits_exhausted"\\|\\|n==="auth"\\)' +
    'return\\{retryable:(!1|false),reason:n\\};',
);

/**
 * The original guard, kept so `--revert` can put it back exactly.
 */
const QUOTA_GUARD_SOURCE =
  'if(t.explicitAbort||t.signals.has("usage_limit")||t.signals.has("credits_exhausted")' +
  '||t.signals.has("content_filter")||t.signals.has("refusal")||n==="abort"||n==="usage_limit"' +
  '||n==="credits_exhausted"||n==="auth")return{retryable:!1,reason:n};';

/**
 * The replacement: a spent quota, exhausted credits and a server error become
 * retryable, and the genuinely terminal cases stay terminal.
 */
const QUOTA_REPLACEMENT =
  'if(t.explicitAbort||t.signals.has("content_filter")||t.signals.has("refusal")||n==="abort"||n==="auth")' +
  'return{retryable:!1,reason:n};' +
  'if(t.existingProtocolCode===Ir.USAGE_LIMIT_EXCEEDED||t.existingProtocolCode===Ir.LLM_CREDITS_EXHAUSTED' +
  '||t.signals.has("usage_limit")||t.signals.has("credits_exhausted")||kqe(t.upstreamStatusCode)||g_(t)===402' +
  '||(g_(t)!==void 0&&g_(t)>=500))' +
  'return{retryable:!0,reason:n};';

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

// The classifier lives in the same chunk as the policy. After patching, the
// original guard is gone, so the patched form is what identifies the state.
const guardPatched = found.source.includes(QUOTA_REPLACEMENT);

const current = found.match.values;
const isPatched = samePolicy(current, PATCHED_POLICY);
const isDefault = samePolicy(current, DEFAULT_POLICY);
const isKnown = KNOWN_POLICIES.some((policy) => samePolicy(current, policy));

if (checkOnly) {
  console.log(
    isPatched
      ? `OK  retry budget is raised: ${formatPolicy(current)}`
      : `BAD retry budget is not the raised one: ${formatPolicy(current)}`,
  );
  console.log(
    guardPatched
      ? 'OK  a spent quota (42212) and exhausted credits (50110) are retried'
      : 'BAD a spent quota (42212) and exhausted credits (50110) are still terminal',
  );
  console.log(`    ${found.path}`);
  process.exit(isPatched && guardPatched ? 0 : 1);
}

if (revert) {
  let source = found.source;
  // The policy literal sits after the classifier guard, so replacing it first
  // leaves the guard's offsets intact.
  if (!isDefault) {
    source =
      source.slice(0, found.match.start) +
      formatPolicy(DEFAULT_POLICY) +
      source.slice(found.match.end);
    console.log(`reverted retry budget to: ${formatPolicy(DEFAULT_POLICY)}`);
  }
  if (guardPatched) {
    source = source.replace(QUOTA_REPLACEMENT, QUOTA_GUARD_SOURCE);
    console.log('reverted: a spent quota and exhausted credits are terminal again');
  }
  if (source !== found.source) {
    writeFileSync(found.path, source);
    console.log(`  ${found.path}`);
  } else {
    console.log('already at MiniMax Code\'s defaults');
  }
  process.exit(0);
}

if (!isKnown) {
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

let source = found.source;

if (isPatched) {
  console.log(`retry budget already raised: ${formatPolicy(current)}`);
} else {
  source =
    source.slice(0, found.match.start) +
    formatPolicy(PATCHED_POLICY) +
    source.slice(found.match.end);
  console.log(`patched retry budget: ${formatPolicy(current)} -> ${formatPolicy(PATCHED_POLICY)}`);
}

if (guardPatched) {
  console.log('spent quota, exhausted credits and server errors are already retryable');
} else {
  // `String.match` with a capturing group returns the group as well, so count
  // the occurrences with a global clone instead.
  const occurrences = [...source.matchAll(new RegExp(QUOTA_GUARD.source, 'g'))];
  if (occurrences.length !== 1) {
    console.error(
      `ABORT: expected exactly one retryable-error classifier guard, found ${occurrences.length}.`,
    );
    process.exit(1);
  }
  source = source.replace(QUOTA_GUARD, QUOTA_REPLACEMENT);
  console.log('patched the classifier: 42212, 50110 and 5xx are now retryable');
}

writeFileSync(found.path, source);
console.log(`  ${found.path}`);
console.log('');
console.log('Six hours of retries — about a hundred attempts, settling to one every five minutes.');
console.log('Re-run this script after `mcode update` — the bundle is replaced wholesale there.');
console.log('Revert with: node scripts/apply-mcode-llm-retry-policy.mjs --revert');
