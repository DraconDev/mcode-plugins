# mcode-retry-on-error

Keeps a MiniMax Code turn going when it ends in an error or a rate-limited tool call.

The plugin installs **two** hooks. The `PostToolUse` hook is the primary path; the `Stop` hook is
the backstop.

## What is covered

| Situation | Which hook | Action |
| --- | --- | --- |
| A tool call failed with a rate limit, quota, timeout, 5xx or network error | `PostToolUse` | Inject a retry instruction into the tool result, while the model is still working. |
| The turn ended with `stopReason: "error"` and the error looks transient | `Stop` | Block the turn, feed a retry instruction back to the model. |
| The last tool call failed transiently and the model still gave up | `Stop` | Same. |
| The turn was aborted | `Stop` | Never retry — the user cancelled. |
| The last tool call failed fatally (`ENOENT`, bad argument) | neither | Never retry — it would fail the same way. |
| The host rejected the call (a validation error, a permission error) | neither | Never retry — the same call is rejected the same way. |
| The turn ended in a permanent error (`401 Unauthorized`, a content-filter refusal) | `Stop` | Never retry — a rejected credential does not fix itself. |
| The model already recovered in this turn and produced a final answer | `Stop` | Never retry — the operation already succeeded. |
| The user sent a new message | `Stop` | Stop; the user has taken over. |
| The turn completed cleanly | `Stop` | Reset the counters so the next failure starts from attempt one. |

## What is not covered

**Provider-level errors never reach a plugin hook, so no plugin can retry them directly.**

When the *model provider* rate-limits the request — the `The model provider is rate limiting
requests. Code: 50150` error — the failure never reaches the session transcript and the `Stop`
hook never fires, because the run aborts before any turn completes. This was measured: across
7,185 assistant messages in a day's transcripts the `stopReason` is only ever `toolUse` or
`stop`, and the provider error string appears in no transcript at all. Forcing a provider failure
with an unreachable endpoint confirmed it: the run failed and the hook never ran.

MiniMax Code handles that layer itself, by retrying the provider request internally — but with a
hardcoded budget of five retries, six attempts over about twenty seconds of waiting, and with
several provider errors classified as terminal so that nothing retries them at all. Both are
fixed by `scripts/apply-mcode-llm-retry-policy.mjs` in the parent repository, which raises the
budget to six hours of retrying and makes a spent quota, exhausted credits and a 5xx retryable.
The goal runtime adds a second, longer-horizon layer on top: it parks the session as
`Usage limited — Resume after provider access recovers` and picks it up again when the provider
allows.

The error that matters here is `Code: 50150`, which is `LLM_TPM_RATE_LIMITED` — a token-per-minute
limit, which the retry classifier treats as retryable. `42212` (`USAGE_LIMIT_EXCEEDED`) and
`50110` (`LLM_CREDITS_EXHAUSTED`) were also terminal until the patch: those are the quotas that
reset on a timer, and giving up on the first response was exactly wrong. An authentication
failure stays terminal — a bad credential will not fix itself.

So a provider rate limit is retried by mcode with a raised budget, and this plugin covers the
failures mcode cannot see: tool calls.

One caveat: Node loads the mcode bundle into memory when a process starts, so the raised budget only
reaches sessions started *after* the patch. A session that was already open keeps the old five-retry
budget until it is restarted, which looks exactly like the patch not having worked. The patch script
lists those processes for you — `node scripts/apply-mcode-llm-retry-policy.mjs --check` prints any
that are still running the old code.

## The hooks

### `PostToolUse` — `hooks/post-tool-retry.mjs`

Fires the instant a tool fails, with the tool result in the payload. The retry instruction is
injected into the tool result, so the model sees the failure and the instruction as one message
while it is still working on the turn.

The output shape matters. A top-level `{"decision": "block", "reason": "..."}` is the *blocking*
form; MiniMax Code treats a blocked `PostToolUse` as a structured block, which closes the
tool-result delivery seam and makes the **next** tool call fail with
`Tool-result delivery seam is closed.` The hook writes a `hookSpecificOutput` with
`additionalContext` instead, which injects the same context without blocking anything.

MiniMax Code strips the `is_error` flag from the `PostToolUse` payload, so the result itself has
to carry the signal:

- A structured result is judged by the markers the runtime writes into it — `"status": "failed"`,
  `"isError": true`. Those are authoritative.
- A plain-text result is judged by its own words, so it has to read like an error report *and*
  match a transient signature.
- A structured result with no status marker is not retried. The runtime always writes one, and
  guessing from text that merely happens to be quoted inside a payload produces false positives —
  reading a file that mentions a 429 is not a rate limit.

Three things the hook is careful about:

- **The delay is clamped.** The runtime kills the hook at its 10s timeout, so a delay that runs
  past the budget would be killed before the first byte of output and the failure would be lost
  silently. The delay is clamped to 7.5s — the same budget the `Stop` hook uses — and the clamped
  value is the one that is actually slept.
- **The attempt counter is reset by a successful call.** The counter is the attempt number of the
  failure the model is working on. A counter that only ever grows announces "attempt 10" for an
  operation the model has never tried, and pushes the model towards giving up. The counter file is
  written to a temporary file and renamed into place, so two tool calls that finish at the same
  moment cannot lose each other's update.
- **The injected detail is the head of the response.** The cause of a failure is at the start —
  the status line, the error message — and the tail is usually the command's own output.

### `Stop` — `hooks/stop-retry.mjs`

Fires when the agent tries to end its turn. The payload carries `stop_hook_active` and
`last_assistant_message` but not the turn's outcome, so the hook reads the session transcript
(`messages.jsonl`) and looks at the tail.

The `Stop` event supports `{"decision": "block", "reason": "..."}`, which does not end the turn —
it continues it. The reason arrives at the model wrapped in `<plugin-hook-context>`. That is a
continuation rather than a replay of the user's prompt, so side effects from earlier tool calls
are not repeated blindly.

Only the *current* turn counts. A tool result that comes before the last assistant message belongs
to a step the model has already recovered from — it produced its final answer after that failure —
so the hook does not retry it. Retrying it would repeat an operation that already succeeded, and
the turn could never end.

A turn error goes through the same classifier as a tool failure, so a permanent cause — a rejected
credential, a content-filter refusal — is not retried and the reason never claims a transient
failure that was not found.

The retry budget is finite, so a permanent failure cannot cost the runtime's full allowance of
eight `Stop` continuations per turn. `stop_hook_active` is honoured: the continuations granted
inside one turn are counted apart from the retry episode, so a turn that recovers and then fails
again still ends.

Both hooks share `hooks/transient.mjs`, which holds the failure signatures. A failure is only
retried when it both reads like a failure and matches a transient signature — a bad request will
not fix itself, so 4xx responses and fatal errors are left alone.

The signatures are tiered:

- **Terminal** — the host refused the call itself: a validation error (`Validation failed for
  tool …`) or a permission error (`Permission denied for …`). These win over everything else,
  because the payload they carry can contain any text at all — a user's own summary, a quota
  policy, a timeout field name — and an identical retry is rejected the same way.
- **Strong** — a phrase that only shows up when something is reported as throttled, overloaded or
  unreachable. The ambiguous words need a context: the bare word `timeout` is a field name in
  half the validation errors mcode produces (`- timeout: must be <= 2147483`) and a constant name
  in half the source files a model reads, so it only counts next to a request, a socket or a
  deadline. `quota` is the word a host policy uses (`command exceeded quota policy`), so it only
  counts when the text says the allowance ran out.
- **Weak** — a bare status number. It only counts in a status position — next to `HTTP`,
  `status code`, `responded` — and next to a failure word. A changelog that lists issue #429, a
  test summary with "515 passed" and a config file with "timeout: 30000" are all numbers that a
  retry cannot fix.

Measured against the real transcripts on this machine (886 failed tool results across 300
sessions), the old signatures called 115 of them transient; 69 were validation errors whose
payload merely mentioned a status code, and every remaining hit was a file that happened to
contain a timeout constant. The tightened signatures call 11, and all 11 are real timeouts and
rate limits.

## Configuration

MiniMax Code gives a hook process a whitelisted environment, so shell variables never reach these
scripts. Configuration lives in a file, in the plugin's data directory:

```
~/.minimax/v2/plugin-data/hooks/mcode-retry-on-error/config.json
```

```json
{
  "enabled": true,
  "delayMs": 5000,
  "backoffMultiplier": 2,
  "maxDelayMs": 60000,
  "maxRetries": 3,
  "maxDurationMs": 120000,
  "debug": false,
  "forceBlock": false
}
```

`maxRetries` is how many continuations one failure episode gets, and `maxDurationMs` how long that
episode may last. The defaults are finite on purpose: the runtime allows eight `Stop`
continuations per turn, so an unbounded plugin turns one permanent failure into eight extra model
round-trips. Three continuations is enough for a rate limit that resets in a minute, and short
enough that a failure that will never work does not eat the session. `null` is the explicit
opt-out and means "no limit". `debug: true` appends a heartbeat line to `heartbeat.log` on every
turn end, and to `post-tool-heartbeat.log` on every tool call, which is how you confirm the hooks
are running and what they can actually see. `forceBlock: true` blocks every turn end (three times,
then stops) — a diagnostic to check the block reaches the model.

The environment variables `MCODE_RETRY_DELAY_MS`, `MCODE_RETRY_MAX_RETRIES`,
`MCODE_RETRY_MAX_DURATION_MS`, `MCODE_RETRY_DISABLED` and `MCODE_RETRY_DEBUG` are also honoured,
but only when a hook is run by hand — mcode does not pass the shell environment through.

## Test

```bash
node scripts/hook-test.mjs           # the Stop hook decisions
node scripts/post-tool-hook-test.mjs # the PostToolUse decisions
```

Both tests feed the hooks the same payload shapes mcode sends. The `Stop` test builds a
throwaway session transcript; the `PostToolUse` test covers each failure signature, each
non-failure lookalike, and the disabled path. Between them they also cover the regressions that
motivated the current signatures: a turn the model already recovered from, a deterministic
failure that used to look transient, the delay clamp, the counter reset, and the finite retry
budget.

## Licence

AGPL-3.0-or-later, matching this repository. The policy is a port of `pi-retry-on-error` (MIT).
