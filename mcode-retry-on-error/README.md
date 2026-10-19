# mcode-retry-on-error

Keeps a MiniMax Code turn going when it ends in an error or a rate-limited tool call.

The plugin installs a `Stop` hook. When the turn is about to end, the hook reads the session
transcript and decides:

| Situation | Action |
| --- | --- |
| The turn ended with `stopReason: "error"` | Block the turn, feed a retry instruction back to the model. |
| The last tool call failed with a rate limit, quota, timeout, 5xx or network error | Same. |
| The turn was aborted | Never retry — the user cancelled. |
| The last tool call failed fatally (`ENOENT`, bad argument) | Never retry — it would fail the same way. |
| The user sent a new message | Stop; the user has taken over. |
| The turn completed cleanly | Reset the counters so the next failure starts from attempt one. |

The MiniMax Code plugin hook format is Claude-Code compatible, and the `Stop` event supports
`{"decision": "block", "reason": "..."}`, which does not end the turn — it continues it. The
reason arrives at the model wrapped in `<plugin-hook-context>`. That is a continuation rather
than a replay of the user's prompt, so side effects from earlier tool calls are not repeated
blindly.

## Configuration

MiniMax Code gives a hook process a whitelisted environment, so shell variables never reach this
script. Configuration lives in a file, in the plugin's data directory:

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
a heartbeat line to `heartbeat.log` in the same directory on every turn end, which is how you
confirm the hook is running. `forceBlock: true` blocks every turn end (three times, then stops) —
a diagnostic to check the block reaches the model.

The environment variables `MCODE_RETRY_DELAY_MS`, `MCODE_RETRY_MAX_RETRIES`,
`MCODE_RETRY_MAX_DURATION_MS`, `MCODE_RETRY_DISABLED` and `MCODE_RETRY_DEBUG` are also honoured,
but only when the hook is run by hand — mcode does not pass the shell environment through.

## Test

```bash
node scripts/hook-test.mjs
```

The test builds a throwaway session transcript and feeds the hook the same payload shape mcode
sends, covering every decision the hook can make.

## Licence

AGPL-3.0-or-later, matching this repository. The policy is a port of `pi-retry-on-error` (MIT).
