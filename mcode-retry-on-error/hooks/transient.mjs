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
 */

/** HTTP statuses that are worth trying again. */
const RETRYABLE_STATUS = /\b(?:429|500|502|503|504|408)\b/;

/** Signatures of a failure that a later attempt could get past. */
const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /\b5\d\d\b/,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /quota/i,
  /overloaded/i,
  /capacity/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /timed? ?out/i,
  /timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
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

/** Does this text match a signature that a later attempt could get past? */
export function isTransient(text) {
  if (!text) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

/** Does this text read like a failure report rather than a result? */
export function looksFailed(text) {
  if (!text) return false;
  return FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Is this a retryable failure?
 *
 * When the host gives an explicit failure flag, that flag alone decides
 * whether it *is* a failure, and only the transient signature still has to
 * match. When there is no flag, the text has to read like a failure *and*
 * match a transient signature.
 *
 * @param {object} options
 * @param {string} options.text - the tool response text
 * @param {boolean} [options.failed] - an explicit failure flag, when the host provides one
 * @returns {boolean}
 */
export function isRetryableFailure({ text, failed }) {
  if (failed === false) return false;
  if (failed !== true && !looksFailed(text)) return false;
  return isTransient(text) || RETRYABLE_STATUS.test(text);
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
