/**
 * Shared retry core.
 *
 * The plugin-level retry hook lives in the MiniMax Code turn lifecycle, which
 * is the right place for a provider error but the wrong place for a rate limit:
 * a 429 is an HTTP response, and only the caller knows whether the call was
 * actually made. This module is the layer that does know.
 *
 * Policy
 * ------
 * Retried:
 *   - 429 Too Many Requests (honouring `Retry-After`)
 *   - 408 Request Timeout
 *   - 500, 502, 503, 504
 *   - network failures: connection reset/refused, DNS, socket hang up, TLS
 *     handshake failures, and `fetch failed`
 *
 * Not retried:
 *   - 400, 401, 403, 404, 405, 409, 422 — the request itself is wrong, or the
 *     credentials are, and repeating it changes nothing
 *   - any error thrown by the caller's own validation
 *
 * The distinction matters: a blind "retry everything" loop turns a typo into
 * an infinite loop and burns the user's quota.
 *
 * Backoff is exponential with jitter, so a fleet of agents hitting the same
 * rate limit does not resynchronise into a thundering herd.
 */

/** HTTP statuses that are worth trying again. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Network-level failures that are worth trying again. */
const RETRYABLE_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|network (?:error|timeout)|TLS handshake|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT)|other side closed/i;

/** An error that carries an HTTP status, so the caller can classify it. */
export class HttpError extends Error {
  constructor(status, message, { body = null, headers = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status);
}

export function isRetryableError(error) {
  if (!error) return false;
  if (error instanceof HttpError) return isRetryableStatus(error.status);
  if (typeof error.status === 'number') return isRetryableStatus(error.status);
  if (error.retryable === true) return true;
  if (error.retryable === false) return false;
  return RETRYABLE_ERROR.test(error.message ?? '');
}

/** Parse a `Retry-After` header into milliseconds, if it is usable. */
export function parseRetryAfter(headers, now = Date.now()) {
  if (!headers) return null;
  const raw = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      };
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

/**
 * Run `fn` with retries.
 *
 * @param {(context: { attempt: number, signal?: AbortSignal }) => Promise<any>} fn
 * @param {object} [options]
 * @param {number} [options.maxRetries] - attempts after the first. Default: unlimited.
 * @param {number} [options.maxDurationMs] - total wall-clock budget. Default: 10 minutes.
 * @param {number} [options.baseDelayMs] - first backoff delay. Default: 2000.
 * @param {number} [options.multiplier] - backoff growth. Default: 2.
 * @param {number} [options.maxDelayMs] - cap on one delay. Default: 60000.
 * @param {boolean} [options.jitter] - randomise the delay. Default: true.
 * @param {AbortSignal} [options.signal]
 * @param {(info: { attempt: number, delayMs: number, error: Error }) => void} [options.onRetry]
 * @returns {Promise<any>}
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = Number.POSITIVE_INFINITY,
    maxDurationMs = 10 * 60_000,
    baseDelayMs = 2_000,
    multiplier = 2,
    maxDelayMs = 60_000,
    jitter = true,
    signal,
    onRetry,
  } = options;

  const startedAt = Date.now();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await fn({ attempt, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isRetryableError(error)) throw error;
      if (attempt > maxRetries) throw error;
      if (Date.now() - startedAt > maxDurationMs) throw error;

      const retryAfter = error instanceof HttpError ? parseRetryAfter(error.headers) : null;
      let delay = retryAfter ?? Math.min(maxDelayMs, baseDelayMs * multiplier ** (attempt - 1));
      delay = Math.min(delay, maxDelayMs);
      if (jitter && retryAfter === null) {
        delay = Math.round(delay * (0.8 + Math.random() * 0.4));
      }

      onRetry?.({ attempt, delayMs: delay, error });
      await sleep(delay, signal);
    }
  }
}

/**
 * `fetch` with the retry policy applied, turning non-2xx responses into
 * `HttpError` so the classifier can act on the status.
 */
export async function fetchWithRetry(url, init = {}, options = {}) {
  return withRetry(
    async ({ signal }) => {
      const response = await fetch(url, { ...init, signal: init.signal ?? signal });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        let message = `HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(body);
          message = parsed?.error?.message ?? parsed?.message ?? message;
        } catch {
          if (body) message = `HTTP ${response.status}: ${body.slice(0, 300)}`;
        }
        throw new HttpError(response.status, message, { body, headers: response.headers });
      }
      return response;
    },
    options,
  );
}
