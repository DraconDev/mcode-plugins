# mcode-retry-on-error

Keeps a MiniMax Code turn going when it ends in an error or a rate-limited tool call.

The plugin installs **two** hooks. The `PostToolUse` hook is the primary path; the `Stop` hook is
the backstop.

## What is covered

| Situation | Which hook | Action |
| --- | --- | --- |
| A tool call failed with a rate limit, quota, timeout, 5xx or network error | `PostToolUse` | Inject a retry instruction into the tool result, while the model is still working. |
| The turn ended with `stopReason: "error"` | `Stop` | Block the turn, feed a retry instruction back to the model. |
| The last tool call failed transiently and the model still gave up | `Stop` | Same. |
| The turn was aborted | `Stop` | Never retry — the user cancelled. |
| The last tool call failed fatally (`ENOENT`, bad argument) | neither | Never retry — it would fail the same way. |
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

### `Stop` — `hooks/stop-retry.mjs`

Fires when the agent tries to end its turn. The payload carries `stop_hook_active` and
`last_assistant_message` but not the turn's outcome, so the hook reads the session transcript
(`messages.jsonl`) and looks at the tail.

The `Stop` event supports `{"decision": "block", "reason": "..."}`, which does not end the turn —
it continues it. The reason arrives at the model wrapped in `<plugin-hook-context>`. That is a
continuation rather than a replay of the user's prompt, so side effects from earlier tool calls
are not repeated blindly.

Both hooks share `hooks/transient.mjs`, which holds the failure signatures. A failure is only
retried when it both reads like a failure and matches a transient signature — a bad request will
not fix itself, so 4xx responses and fatal errors are left alone.

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
  "maxRetries": null,
  "maxDurationMs": null,
  "debug": false,
  "forceBlock": false
}
```

`maxRetries` and `maxDurationMs` are `null` by default, meaning unlimited. `debug: true` appends
a heartbeat line to `heartbeat.log` on every turn end, and to `post-tool-heartbeat.log` on every
tool call, which is how you confirm the hooks are running and what they can actually see.
`forceBlock: true` blocks every turn end (three times, then stops) — a diagnostic to check the
block reaches the model.

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
non-failure lookalike, and the disabled path.

## Licence

AGPL-3.0-or-later, matching this repository. The policy is a port of `pi-retry-on-error` (MIT).
