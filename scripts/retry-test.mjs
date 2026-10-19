#!/usr/bin/env node
/**
 * Test the shared retry policy.
 *
 * The policy is the point of the image plugins: a rate limit should not end
 * the call, but a bad request should. These tests pin both halves.
 *
 *   node scripts/retry-test.mjs
 */

import { HttpError, isRetryableError, parseRetryAfter, withRetry } from '../shared/retry.mjs';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

// 1. A 429 is retried and the eventual success is returned.
{
  let attempts = 0;
  const value = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 4) throw new HttpError(429, 'rate limited');
      return 'ok';
    },
    { baseDelayMs: 1, jitter: false },
  );
  check('429 is retried until it succeeds', value === 'ok' && attempts === 4, `attempts=${attempts}`);
}

// 2. A 400 is not retried.
{
  let attempts = 0;
  let caught = null;
  try {
    await withRetry(
      async () => {
        attempts += 1;
        throw new HttpError(400, 'bad request');
      },
      { baseDelayMs: 1 },
    );
  } catch (error) {
    caught = error;
  }
  check('400 is not retried', attempts === 1 && caught?.status === 400, `attempts=${attempts}`);
}

// 3. A 401 is not retried.
{
  let attempts = 0;
  try {
    await withRetry(
      async () => {
        attempts += 1;
        throw new HttpError(401, 'unauthorized');
      },
      { baseDelayMs: 1 },
    );
  } catch {
    // expected
  }
  check('401 is not retried', attempts === 1, `attempts=${attempts}`);
}

// 4. 5xx is retried.
{
  let attempts = 0;
  const value = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new HttpError(503, 'unavailable');
      return 'recovered';
    },
    { baseDelayMs: 1, jitter: false },
  );
  check('503 is retried', value === 'recovered' && attempts === 3, `attempts=${attempts}`);
}

// 5. A network failure is retried.
{
  let attempts = 0;
  const value = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw new TypeError('fetch failed');
      return 'reconnected';
    },
    { baseDelayMs: 1 },
  );
  check('network failure is retried', value === 'reconnected' && attempts === 2, `attempts=${attempts}`);
}

// 6. The retry budget is honoured.
{
  let attempts = 0;
  try {
    await withRetry(
      async () => {
        attempts += 1;
        throw new HttpError(429, 'rate limited');
      },
      { maxRetries: 4, baseDelayMs: 1 },
    );
  } catch {
    // expected
  }
  check('maxRetries bounds the attempts', attempts === 5, `attempts=${attempts}`);
}

// 7. Each retry waits a little longer than the last.
{
  const delays = [];
  try {
    await withRetry(
      async () => {
        throw new HttpError(429, 'rate limited');
      },
      { maxRetries: 5, baseDelayMs: 10, multiplier: 2, jitter: false, onRetry: (info) => delays.push(info.delayMs) },
    );
  } catch {
    // expected
  }
  const increasing = delays.every((delay, index) => index === 0 || delay > delays[index - 1]);
  check(
    'backoff grows between attempts',
    increasing && delays.length === 5,
    `delays=${delays.join(',')}`,
  );
}

// 8. Retry-After is honoured.
{
  const headers = new Headers({ 'retry-after': '7' });
  check('Retry-After in seconds is parsed', parseRetryAfter(headers) === 7000, String(parseRetryAfter(headers)));
}

// 9. A Retry-After date is parsed.
{
  const when = new Date(Date.now() + 30_000).toUTCString();
  const headers = new Headers({ 'retry-after': when });
  const parsed = parseRetryAfter(headers);
  check('Retry-After as a date is parsed', parsed !== null && parsed > 25_000 && parsed <= 30_000, String(parsed));
}

// 10. The default policy is 15 retries.
{
  let attempts = 0;
  try {
    await withRetry(
      async () => {
        attempts += 1;
        throw new HttpError(429, 'rate limited');
      },
      { baseDelayMs: 1 },
    );
  } catch {
    // expected
  }
  check('the default policy allows 15 retries', attempts === 16, `attempts=${attempts}`);
}

// 11. Classification helpers agree with the policy.
{
  check('isRetryableError accepts 429', isRetryableError(new HttpError(429, 'x')));
  check('isRetryableError rejects 404', !isRetryableError(new HttpError(404, 'x')));
  check('isRetryableError accepts fetch failed', isRetryableError(new Error('fetch failed')));
  check('isRetryableError rejects a plain error', !isRetryableError(new Error('something else')));
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
