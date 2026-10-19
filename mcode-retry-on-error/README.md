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
`{"decision": "block", "reason": "..."}`, which does not end the turn — it continues it. That is a
continuation rather than a replay of the user's prompt, so side effects from earlier tool calls
are not repeated blindly.

## Known gap

**mcode 0.6.12 does not dispatch hooks declared by local plugins.** The plugin loads — its skill
appears in the session catalog — but the hook process is never spawned, so this plugin currently
has no effect.

Verified against both plugin manifest formats (`.minimax-plugin/plugin.json` and
`.claude-plugin/plugin.json`) and across three hook events (`SessionStart`, `PostToolUse`,
`Stop`): the plugin's data directory is never created, which is the earliest observable sign that
the hook runner did not run. Skills, MCP servers and icons from the same plugin load normally, so
it is specifically hook dispatch that is inert for local plugins.

The hook logic is complete and covered by `scripts/hook-test.mjs` (8/8). It is kept because the
logic is correct and it will start working the moment upstream dispatch is fixed — no change is
needed here.

The retry behaviour that *does* work today is the call-level one in `shared/retry.mjs`, used by
the image plugins.

## Configuration

MiniMax Code gives a hook process a whitelisted environment, so shell variables never reach this
script. Configuration lives in a file:

```
~/.minimax/plugins/.plugin-data/mcode-retry-on-error/config.json
```

```json
{
  "enabled": true,
  "delayMs": 5000,
  "backoffMultiplier": 2,
  "maxDelayMs": 60000,
  "maxRetries": null,
  "maxDurationMs": null
}
```

`maxRetries` and `maxDurationMs` are `null` by default, meaning unlimited. `forceBlock: true` is
a diagnostic that blocks every turn, to check the hook is wired up.

## Test

```bash
node scripts/hook-test.mjs
```

## Licence

AGPL-3.0-or-later, matching this repository. The policy is a port of `pi-retry-on-error` (MIT).
