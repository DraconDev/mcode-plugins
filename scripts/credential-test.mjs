#!/usr/bin/env node
/**
 * Test credential resolution.
 *
 * The contract the README makes is that neither image plugin *needs* pi: an
 * environment variable is enough on its own, and pi's auth store is a
 * convenience for people who already keep one. These tests prove that, with
 * a home directory that has no pi store in it at all.
 *
 *   node scripts/credential-test.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

/** A token shaped like the real thing, so the account id can be read from it. */
function fakeToken(accountId = 'acct-123') {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

const AGNES_PROBE = `
const { resolveApiKey } = await import(${JSON.stringify(join(REPO_ROOT, 'mcode-agnes/server/auth.mjs'))});
const r = resolveApiKey('agnes', 'AGNES_API_KEY');
console.log(r.key ? 'resolved ' + r.source : 'NO KEY');
`;

const CODEX_PROBE = `
const { resolveCodexCredential } = await import(${JSON.stringify(join(REPO_ROOT, 'mcode-codex/server/auth.mjs'))});
try {
  const r = await resolveCodexCredential();
  console.log('resolved ' + r.source + ' account=' + r.accountId);
} catch (e) {
  console.log('ERROR ' + e.message);
}
`;

/**
 * Run a probe in a child process with a controlled home directory.
 *
 * @param {string} home - the home directory the probe sees
 * @param {string} code - the probe
 * @param {object} [env] - extra environment variables
 */
function probe(home, code, env = {}) {
  try {
    return execFileSync('node', ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, ...env },
    }).trim();
  } catch (error) {
    return `ERROR ${(error.stderr ?? error.message ?? '').split('\n')[0]}`;
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'mcode-credential-test-'));

// A home with no pi store in it — the situation of somebody who has never
// heard of pi.
const bareHome = join(sandbox, 'bare');
mkdirSync(bareHome, { recursive: true });

// A home with a pi store in it.
const piHome = join(sandbox, 'withpi');
mkdirSync(join(piHome, '.pi', 'agent'), { recursive: true });
writeFileSync(
  join(piHome, '.pi', 'agent', 'auth.json'),
  JSON.stringify({
    agnes: { type: 'api_key', key: 'pi-agnes-key' },
    'openai-codex': {
      type: 'oauth',
      access: fakeToken('acct-pi'),
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      accountId: 'acct-pi',
    },
  }),
);

try {
  // 1. The standalone path: an environment variable and nothing else.
  check(
    'Agnes resolves from the environment with no pi store',
    probe(bareHome, AGNES_PROBE, { AGNES_API_KEY: 'sk-env' }) === 'resolved env:AGNES_API_KEY',
  );
  check(
    'Codex resolves from the environment with no pi store',
    probe(bareHome, CODEX_PROBE, { CODEX_IMAGE_ACCESS_TOKEN: fakeToken() }) ===
      'resolved env account=acct-123',
  );

  // 2. With no environment variable and no pi store, the error has to name
  //    the environment variable first — that is the path that always works.
  const noAgnes = probe(bareHome, AGNES_PROBE);
  check(
    'Agnes without any credential reports no key',
    noAgnes === 'NO KEY',
    noAgnes,
  );
  const noCodex = probe(bareHome, CODEX_PROBE);
  check(
    "Codex without any credential names the environment variable first",
    noCodex.includes('CODEX_IMAGE_ACCESS_TOKEN') && noCodex.indexOf('CODEX_IMAGE_ACCESS_TOKEN') <
      noCodex.indexOf('pi'),
    noCodex.slice(0, 90),
  );

  // 3. pi's store is a fallback, not a requirement.
  check(
    'Agnes falls back to pi\'s auth store',
    probe(piHome, AGNES_PROBE) === 'resolved pi:agnes',
    probe(piHome, AGNES_PROBE),
  );
  check(
    'Codex falls back to pi\'s auth store',
    probe(piHome, CODEX_PROBE) === 'resolved pi:openai-codex account=acct-pi',
    probe(piHome, CODEX_PROBE),
  );

  // 4. The environment wins when both are available.
  check(
    'the environment wins over pi\'s store for Agnes',
    probe(piHome, AGNES_PROBE, { AGNES_API_KEY: 'sk-env' }) === 'resolved env:AGNES_API_KEY',
  );
  check(
    'the environment wins over pi\'s store for Codex',
    probe(piHome, CODEX_PROBE, { CODEX_IMAGE_ACCESS_TOKEN: fakeToken('acct-env') }) ===
      'resolved env account=acct-env',
  );

  // 5. A secret must never appear in what the plugin reports.
  const reported = probe(bareHome, AGNES_PROBE, { AGNES_API_KEY: 'sk-super-secret-value' });
  check('the credential value is not reported', !reported.includes('sk-super-secret-value'), reported);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
