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
  // An explicit flag wins over everything else, including the HTTP status.
  // This is how a caller says "this particular failure is not worth another
  // try" — a Cloudflare challenge, say, which arrives with a retryable status
  // but will never succeed on a retry.
  if (error.retryable === true) return true;
  if (error.retryable === false) return false;
  if (error instanceof HttpError) return isRetryableStatus(error.status);
  if (typeof error.status === 'number') return isRetryableStatus(error.status);
  return RETRYABLE_ERROR.test(error.message ?? '');
}

/**
 * The `Retry-After` hint on an error, if it carries one.
 *
 * `HttpError` is the normal shape, but a caller may throw its own error with
 * a `status` and a `headers` map. The classifier accepts that shape, so the
 * delay has to be read from it too — otherwise a server-requested wait is
 * silently dropped for exactly the errors that are duck-typed.
 */
function retryAfterOf(error) {
  if (!error) return null;
  if (error instanceof HttpError) return parseRetryAfter(error.headers);
  if (error.headers) return parseRetryAfter(error.headers);
  return null;
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

/**
 * Wait, unless the signal aborts.
 *
 * The abort listener is removed when the wait ends, however it ends. Leaving
 * it attached would accumulate one dead listener per retry on the caller's
 * signal, and a signal shared across calls would grow without bound.
 *
 * When the wait is aborted, the rejection carries the error that caused the
 * retry in the first place — a bare "Aborted" would hide the real failure
 * from the caller and from the logs.
 */
const sleep = (ms, signal, cause) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    let onAbort = null;
    const detach = () => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      onAbort = null;
    };
    const timer = setTimeout(() => {
      detach();
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        detach();
        const error = new Error('Aborted');
        if (cause) error.cause = cause;
        reject(error);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

/**
 * Run `fn` with retries.
 *
 * The default policy is deliberately eager: 15 retries after the first
 * attempt — 16 calls in total — each a little later than the last, so a
 * transient rate limit clears on its own instead of the user having to re-run
 * the prompt. Roughly two to three minutes.
 *
 * @param {(context: { attempt: number, signal?: AbortSignal }) => Promise<any>} fn
 * @param {object} [options]
 * @param {number} [options.maxRetries] - attempts after the first. Default: 15.
 * @param {number} [options.maxDurationMs] - total wall-clock budget. Default: 15 minutes.
 *   A delay is clamped to what is left of the budget, and no attempt starts
 *   after the budget has expired.
 * @param {number} [options.baseDelayMs] - first backoff delay. Default: 1500.
 * @param {number} [options.multiplier] - backoff growth. Default: 1.6.
 * @param {number} [options.maxDelayMs] - cap on one computed delay. Default: 12000.
 * @param {number} [options.retryAfterMaxMs] - cap on a server-requested delay. Default: 120000.
 * @param {boolean} [options.jitter] - randomise the delay. Default: true.
 * @param {AbortSignal} [options.signal]
 * @param {(info: { attempt: number, delayMs: number, error: Error }) => void} [options.onRetry]
 * @returns {Promise<any>}
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 15,
    maxDurationMs = 15 * 60_000,
    baseDelayMs = 1_500,
    multiplier = 1.6,
    maxDelayMs = 12_000,
    retryAfterMaxMs = 120_000,
    jitter = true,
    signal,
    onRetry,
  } = options;

  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;

  for (;;) {
    // The budget is checked before every attempt, not only after a failure,
    // so a call can never start one attempt past its own deadline.
    if (attempt > 0 && Date.now() - startedAt > maxDurationMs) throw lastError;

    attempt += 1;
    try {
      return await fn({ attempt, signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (!isRetryableError(error)) throw error;
      if (attempt > maxRetries) throw error;

      // How much of the budget is left. The delay is clamped to it below, so
      // a long `Retry-After` cannot push the call past its own deadline.
      const remaining = maxDurationMs - (Date.now() - startedAt);
      if (remaining <= 0) throw error;

      const retryAfter = retryAfterOf(error);
      // A server that names a delay gets it honoured — but not beyond the
      // explicit ceiling, so a broken `Retry-After: 86400` cannot wedge a call.
      const delay = retryAfter !== null
        ? Math.min(retryAfter, retryAfterMaxMs)
        : Math.min(maxDelayMs, baseDelayMs * multiplier ** (attempt - 1));
      const jittered = jitter && retryAfter === null
        ? Math.round(delay * (0.85 + Math.random() * 0.3))
        : delay;
      const bounded = Math.max(0, Math.min(jittered, remaining));

      onRetry?.({ attempt, delayMs: bounded, error });
      await sleep(bounded, signal, error);
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
