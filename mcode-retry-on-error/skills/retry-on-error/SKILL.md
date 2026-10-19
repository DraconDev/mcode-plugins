---
name: retry-on-error
description: >-
  Guidance for the mcode-retry-on-error plugin, which automatically continues a MiniMax Code turn
  that ended in an error or a rate-limited tool call instead of giving up. Use when a
  transient failure should be retried rather than reported, when an image or video generation hit
  a quota, or when the user asks to keep trying until something succeeds.
---

# Retry On Error

This plugin installs two hooks. The `PostToolUse` hook fires the instant a tool fails and feeds a
retry instruction back to the model. The `Stop` hook catches a turn that tried to end in an error,
or a turn where the last tool call failed transiently and the model gave up anyway. Either way the
model repeats the same operation.

You do not have to do anything special for this to happen. It is automatic.

## What gets retried

- **Transient tool failures.** A tool result that reports a failure whose text matches a rate
  limit, quota, timeout, 5xx, or network pattern. A 429 from an image API is the common case.
- **Turn errors.** The turn ended with `stopReason: "error"`.

## What is never retried

- **An aborted turn.** The user cancelled; that is a decision, not a failure.
- **A fatal tool error.** `ENOENT`, a bad argument, a validation failure — retrying would fail
  the same way. Only transient-looking failures are retried.
- **After the user interjects.** A new user message resets the retry state, so the loop always
  yields to the human.
- **A clean turn.** Success resets the counters, so the next failure starts from attempt one.

## What this plugin cannot reach

**Provider rate limits are handled by MiniMax Code itself, not by this plugin.** The
`The model provider is rate limiting requests. Code: 50150` error never reaches the session
transcript, and the `Stop` hook does not fire for it — the run aborts before a turn completes.

MiniMax Code retries that layer internally, and its budget has been raised on this machine from
five retries to six hours of retrying by `scripts/apply-mcode-llm-retry-policy.mjs` in the plugin
repository — the first attempts stay close together, then it settles to one every five minutes
for as long as it takes. The goal runtime adds a second, longer-horizon layer: it parks the
session as `Usage limited — Resume after provider access recovers` and resumes it when the
provider allows.

Note the difference between a throttled provider and an exhausted quota. `Code: 50150` is a
token-per-minute limit and is retried. A genuinely exhausted quota ends the turn immediately and
nothing retries it — that is correct, and waiting for the reset is the right answer.

So if you see a rate limit, the recovery is already running. Do not try to work around it by hand
and do not change your approach. If the turn genuinely ended and the user asks you to continue, say
what you were doing and pick it up again.

## How to work with it

When a turn is retried, the reason you are given names the failure and the attempt number. Treat
it as an instruction to repeat the *same* operation:

- Do **not** change the approach, rewrite the prompt, or switch tools because the first attempt
  failed.
- Do **not** apologise or explain that you are retrying; just make the call again.
- If the failure is a rate limit, the same call is the right call. The plugin is already spacing
  attempts out with exponential backoff.

The same instruction arrives inside a tool result when a tool fails mid-turn. Treat it the same
way — but check the result you actually got. If the tool succeeded and the suggestion was based
on text that merely looked like a failure, carry on rather than repeating a command that
already worked.

If the plugin is not doing what you expect, say so plainly rather than looping by hand — the
plugin's own backoff is already better than a manual retry loop.

## Bounding it

The plugin is deliberately relentless, but it is not infinite in every sense. Configuration lives
in a file, because mcode gives a hook process a whitelisted environment and shell variables never
reach it:

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
  "debug": false
}
```

`maxRetries` and `maxDurationMs` are `null` by default, meaning unlimited. `debug: true` appends
a heartbeat line to `heartbeat.log` on every turn end and to `post-tool-heartbeat.log` on every
tool call.

Because the hook itself has a 10-second execution budget, a delay longer than that is trimmed to
fit and the remainder is handed back to the model as a note. Tools that own their own retry
policy — the image and video generators — apply the full backoff themselves.

## Troubleshooting

- **The turn still ended.** The failure was not transient, the turn was aborted, or the user
  interjected. Check the failure text for a 429/5xx/timeout signature.
- **It retried too eagerly.** Set `maxRetries` to a small number.
- **It never fires.** Confirm the plugin is enabled (`mcode plugin list`) and that the session was
  started after enabling it. Set `"debug": true` and look at
  `~/.minimax/v2/plugin-data/hooks/mcode-retry-on-error/heartbeat.log` — a line per turn end means
  the hook is running.
- **A tool call was retried that should not have been.** The hook reads the tool result, not the
  tool's own error flag, because MiniMax Code strips that flag from the `PostToolUse` payload.
  `post-tool-heartbeat.log` shows exactly what the hook saw.
