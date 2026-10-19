---
name: retry-on-error
description: >-
  Guidance for the mcode-retry-on-error plugin, which automatically continues a MiniMax Code turn
  that ended in a provider error or a rate-limited tool call instead of giving up. Use when a
  transient failure should be retried rather than reported, when an image or video generation hit
  a quota, or when the user asks to keep trying until something succeeds.
---

# Retry On Error

This plugin installs a `Stop` hook. When a turn ends in a provider error, or the last thing that
happened was a tool call that failed with a transient error — a rate limit, a quota, a timeout, a
5xx, a dropped connection — the hook blocks the turn from ending and feeds a retry instruction
back to the model. The model then repeats the same operation.

You do not have to do anything special for this to happen. It is automatic.

## What gets retried

- **Provider errors.** The turn ended with `stopReason: "error"`.
- **Transient tool failures.** The last tool result was an error whose text matches a rate limit,
  quota, timeout, 5xx, or network pattern. A 429 from an image API is the common case.

## What is never retried

- **An aborted turn.** The user cancelled; that is a decision, not a failure.
- **A fatal tool error.** `ENOENT`, a bad argument, a validation failure — retrying would fail
  the same way. Only transient-looking failures are retried.
- **After the user interjects.** A new user message resets the retry state, so the loop always
  yields to the human.
- **A clean turn.** Success resets the counters, so the next failure starts from attempt one.

## How to work with it

When a turn is retried, the reason you are given names the failure and the attempt number. Treat
it as an instruction to repeat the *same* operation:

- Do **not** change the approach, rewrite the prompt, or switch tools because the first attempt
  failed.
- Do **not** apologise or explain that you are retrying; just make the call again.
- If the failure is a rate limit, the same call is the right call. The plugin is already spacing
  attempts out with exponential backoff.

If the plugin is not doing what you expect, say so plainly rather than looping by hand — the
plugin's own backoff is already better than a manual retry loop.

## Bounding it

The plugin is deliberately relentless, but it is not infinite in every sense. Two environment
variables put a ceiling on it if you want one:

| Variable | Default | Effect |
| --- | --- | --- |
| `MCODE_RETRY_MAX_RETRIES` | unlimited | Attempts before giving up. |
| `MCODE_RETRY_MAX_DURATION_MS` | unlimited | Total window before giving up. |
| `MCODE_RETRY_DELAY_MS` | `5000` | Base backoff delay. |
| `MCODE_RETRY_BACKOFF_MULTIPLIER` | `2` | Growth per attempt. |
| `MCODE_RETRY_MAX_DELAY_MS` | `60000` | Cap on a single delay. |
| `MCODE_RETRY_DISABLED` | unset | Set to `1` to turn the hook into a no-op. |

Because the hook itself has a 10-second execution budget, a delay longer than that is trimmed to
fit and the remainder is handed back to the model as a note. Tools that own their own retry
policy — the image and video generators — apply the full backoff themselves.

## Troubleshooting

- **The turn still ended.** The failure was not transient, the turn was aborted, or the user
  interjected. Check the failure text for a 429/5xx/timeout signature.
- **It retried too eagerly.** Set `MCODE_RETRY_MAX_RETRIES` to a small number.
- **It never fires.** Confirm the plugin is enabled (`mcode plugin list`) and that the session was
  started after enabling it. Set `MCODE_RETRY_DEBUG=1` to have the hook narrate its decisions on
  stderr.
