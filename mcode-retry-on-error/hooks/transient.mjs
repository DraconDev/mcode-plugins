/**
 * Shared failure detection for the retry hooks.
 *
 * Two hooks use this:
 *
 *   PostToolUse — fires the moment a tool fails, with the tool response in
 *                 the payload. This is the primary path: the failure is
 *                 injected into the conversation while the model is still
 *                 working on the turn.
 *   Stop        — fires when the agent tries to end its turn. This is the
 *                 backstop for a model that gave up instead of retrying.
 *
 * The rules are deliberately conservative. A tool is only treated as
 * transiently failed when it both *looks like a failure* and *matches a
 * transient signature*. A successful `grep` that happens to print "429" is not
 * a rate limit, and retrying it would waste the user's time and quota.
 *
 * The tiers
 * ---------
 *   terminal — the host refused the call itself: the arguments were invalid
 *              or the operation was not permitted. An identical retry fails
 *              in exactly the same way, so these win over every other signal.
 *   strong   — a phrase that only shows up when something is reported as
 *              throttled, overloaded or unreachable.
 *   weak     — a bare status number, which only counts in a status position
 *              and next to a failure word.
 */

/**
 * Host-level rejections.
 *
 * These are decided by the host, not by the operation that failed, and the
 * payload they carry can contain anything at all — a user's own summary
 * text, a quota policy, a timeout field name. Retrying them cannot work,
 * so they are matched before any transient signature is even considered.
 */
const TERMINAL_FAILURE = [
  // The host rejected the arguments it was given.
  /\bvalidation failed for tool\b/i,
  // The host refused the operation itself.
  /\bpermission\b[^\n]{0,40}\b(?:denied|invalid|blocked|refused|not permitted|unavailable)\b/i,
  /\bnot permitted\b/i,
  // The host cannot do what was asked at all.
  /\bhost[_ ]capability[_ ]unavailable\b/i,
];

/**
 * Words that say a limit is actually in force.
 */
const LIMIT_CONTEXT = String.raw`\b(?:429|too\s+many\s+requests|exceeded|exhausted|hit|reached|triggered|denied|blocked|back\s+off|try\s+again|please\s+retry|retry\s+later|window)\b`;

/**
 * Rate limits.
 *
 * "rate limit" is also the phrase every API client's own code and docs use,
 * so it only counts next to a word that says the limit is in force — and
 * never in a sentence that merely mentions one.
 */
const RATE_LIMIT_TRANSIENT = [
  /\brate[_\s-]?limit[_\s-]?(?:exceeded|exhausted|hit|reached|triggered)\b/i,
  new RegExp(`rate[\\s_-]?limit(?:ed|ing|s)?\\b[^\\n]{0,40}${LIMIT_CONTEXT}`, 'i'),
  new RegExp(`${LIMIT_CONTEXT}[^\\n]{0,40}rate[\\s_-]?limit(?:ed|ing|s)?\\b`, 'i'),
];

/**
 * Quota exhaustion.
 *
 * "quota" is also the word a host policy uses — "command exceeded quota
 * policy" is a blocked command, not an exhausted allowance — so a quota only
 * counts when the text says the allowance ran out, and never when a policy
 * word follows it.
 */
const QUOTA_TRANSIENT = [
  /\binsufficient[_\s-]?quota\b/i,
  /\bquota[_\s-]?(?:exceeded|exhausted|depleted)\b/i,
  /\b(?:exceeded|exhausted|depleted|insufficient|ran out|used up)\b[^\n]{0,60}\bquota\b(?![-_\s]*(?:polic|rule|guard|check))/i,
  /\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted|exhaustion|ran out)\b/i,
];

/**
 * Words that put a timeout in a request, a socket or a deadline.
 *
 * The word boundaries matter: "REAL_SERVER_TIMEOUT_MS" is a constant name,
 * not a server that timed out.
 */
const TIMEOUT_CONTEXT =
  String.raw`\b(?:request|requests|connect|connecting|connection|connected|response|respond|responding|responded|returned|fetch|fetching|socket|upstream|server|endpoint|api|network|handshake|deadline|operation|command|curl|await|after)\b`;

/**
 * Timeouts.
 *
 * "timed out" reports that something timed out, so it counts on its own. The
 * bare word "timeout" does not: it is a field name in the validation errors
 * mcode produces ("- timeout: must be <= 2147483") and a constant name in
 * half the source files a model reads. It only counts next to a word that
 * puts it in a request, a socket or a deadline.
 */
const TIMEOUT_TRANSIENT = [
  /\btimed\s?out\b/i,
  /\btimeout\b[^\n]{0,60}\b(?:exceeded|elapsed)\b/i,
  new RegExp(`${TIMEOUT_CONTEXT}[^\\n]{0,60}\\btimeout\\b`, 'i'),
  new RegExp(`\\btimeout\\b[^\\n]{0,60}${TIMEOUT_CONTEXT}`, 'i'),
];

/**
 * A status number that can be transient: 429, 408 and the 5xx range.
 */
const STATUS_NUMBER = String.raw`\b(?:429|5\d\d|408)\b`;

/**
 * Words that put a number in a status position.
 */
const STATUS_CONTEXT = String.raw`\b(?:HTTP|status(?:\s+code)?|code|error\s+code|responded|returned|received|response|reply|upstream|server|service|endpoint|api|request|curl|errno|error)\b`;

/**
 * Weak transient signals: a bare HTTP status.
 *
 * A number only counts when it is in a *status position* — next to "HTTP",
 * "status code", "responded", "upstream" — and the text reads like a
 * failure. A changelog that lists issue #429, a test summary with "515
 * passed" and a config file with "timeout: 30000" are all numbers that a
 * retry cannot fix.
 */
const WEAK_TRANSIENT = [
  new RegExp(`${STATUS_CONTEXT}[^\\n]{0,20}${STATUS_NUMBER}`, 'i'),
  new RegExp(`${STATUS_NUMBER}[^\\n]{0,20}${STATUS_CONTEXT}`, 'i'),
];

/**
 * Strong transient signals.
 *
 * These are phrases that only appear when something is actually being reported
 * as throttled, overloaded or unreachable. The numeric forms live in the weak
 * tier below and have to sit next to a failure word in a status position.
 */
const STRONG_TRANSIENT = [
  /too many requests/i,
  /overloaded/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  ...RATE_LIMIT_TRANSIENT,
  ...QUOTA_TRANSIENT,
  ...TIMEOUT_TRANSIENT,
];

/**
 * Markers that a piece of text is reporting a *failure*, as opposed to
 * reporting something that merely contains a number or the word "error".
 */
const FAILURE_PATTERNS = [
  /exit(?:ed)?(?: with)? (?:code|status)\s*[:=]?\s*[1-9]\d*/i,
  /\bexit code\s*[1-9]\d*/i,
  /\bcommand failed\b/i,
  /\btool (?:call )?failed\b/i,
  /\bcall failed\b/i,
  /\berror\b/i,
  /\bfailed\b/i,
  /\bfailure\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  // An HTTP error response is a failure on its own. The status code has to be
  // paired with a reason phrase, so a successful command that happens to print
  // "429" is not mistaken for one.
  /\bHTTP\/\d(?:\.\d)?\s+[45]\d\d\b/i,
  /\bHTTP\s+[45]\d\d\b/i,
  /\bstatus(?:\s+code)?\s*[:=]\s*[45]\d\d\b/i,
  /\b[45]\d\d\s+(?:too\s+many\s+requests|unauthorized|forbidden|not\s+found|bad\s+request|internal\s+server\s+error|service\s+unavailable|bad\s+gateway|gateway\s+timeout|request\s+timeout)\b/i,
];

/** Pull readable text out of a tool response, whatever shape it arrives in. */
export function textOf(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block.text === 'string') return block.text;
        if (block && typeof block.content === 'string') return block.content;
        return '';
      })
      .join('\n');
  }
  if (typeof content === 'object') {
    // A tool response can be a structured object (e.g. {details: {...}}).
    // Flatten it so the same text rules apply.
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

/**
 * Is this a failure the host itself refused?
 *
 * These are terminal: the arguments were rejected or the operation was not
 * permitted, so the same call fails the same way forever.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isTerminalFailure(text) {
  if (!text) return false;
  return TERMINAL_FAILURE.some((pattern) => pattern.test(text));
}

/**
 * Does this text match a signature that a later attempt could get past?
 *
 * A strong signal is enough on its own. A bare status number only counts
 * when it is in a status position and the text also reads like a failure.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isTransient(text) {
  if (!text) return false;
  if (STRONG_TRANSIENT.some((pattern) => pattern.test(text))) return true;
  if (!looksFailed(text)) return false;
  return WEAK_TRANSIENT.some((pattern) => pattern.test(text));
}

/** Does this text read like a failure report rather than a result? */
export function looksFailed(text) {
  if (!text) return false;
  return FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/** Structured failure markers inside a tool result. */
const STRUCTURED_FAILURE = /"is_?error"\s*:\s*true|"status"\s*:\s*"(?:failed|error|aborted|canceled|cancelled)"/i;

/** A tool result that reports success explicitly. */
const STRUCTURED_SUCCESS = /"status"\s*:\s*"succeeded"/i;

/**
 * Is this a retryable failure?
 *
 * When the host gives an explicit failure flag, that flag alone decides
 * whether it *is* a failure, and only the transient signature still has to
 * match.
 *
 * Otherwise the tool result is inspected. MiniMax Code strips the `is_error`
 * flag from the PostToolUse payload, so the result itself has to carry the
 * signal:
 *
 *   - A structured result is judged by the markers the runtime writes into it
 *     — `"status": "failed"`, `"isError": true`. Those are authoritative.
 *   - A plain-text result is judged by its own words, so it has to read like
 *     an error report *and* match a transient signature.
 *
 * A structured result with no status marker is not retried. The runtime
 * always writes one, and guessing from text that merely happens to be quoted
 * inside a payload produces false positives — reading a file that mentions a
 * 429 is not a rate limit.
 *
 * A host-level rejection is never retried, whatever else the payload says.
 *
 * @param {object} options
 * @param {string} options.text - the tool response text
 * @param {boolean} [options.failed] - an explicit failure flag, when the host provides one
 * @param {boolean} [options.isPlainText] - the response was a plain string, not a structured object
 * @returns {boolean}
 */
export function isRetryableFailure({ text, failed, isPlainText = false }) {
  if (failed === false) return false;
  if (isTerminalFailure(text)) return false;
  if (failed === true) return isTransient(text);

  if (STRUCTURED_FAILURE.test(text)) return isTransient(text);
  if (STRUCTURED_SUCCESS.test(text)) return false;

  if (!isPlainText) return false;
  if (!looksFailed(text)) return false;
  return isTransient(text);
}

/**
 * The part of a failure worth showing the model.
 *
 * The cause of a failure sits at the *start* of a response — the status line,
 * the error message — and the tail is usually the command's own output. A
 * response longer than the limit whose cause is at the start must not lose
 * it, so the first failure-looking line wins and the head of the response is
 * the fallback.
 *
 * @param {string} text
 * @param {number} [limit] - maximum number of characters to return
 * @returns {string}
 */
export function failureDetail(text, limit = 300) {
  if (!text) return '';
  const line = text
    .split('\n')
    .find((candidate) => looksFailed(candidate) || isTransient(candidate));
  if (line) return line.trim().slice(0, limit);
  return text.slice(0, limit);
}

/**
 * The instruction injected when a transient failure is detected.
 *
 * @param {object} options
 * @param {string} options.toolName
 * @param {string} options.detail
 * @param {number} options.attempt
 * @returns {string}
 */
export function retryInstruction({ toolName, detail, attempt }) {
  const name = toolName ? `\`${toolName}\`` : 'The tool';
  return (
    `${name} failed with a transient error (attempt ${attempt}): ${detail}\n\n` +
    'This is a temporary failure, not a bad request. Run the same operation again now, ' +
    'with the same arguments. Do not change the approach, do not give up, and do not ' +
    'apologise — just retry.'
  );
}
