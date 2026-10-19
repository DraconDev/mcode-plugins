# mcode-plugins

MiniMax Code plugins for this machine, plus the small runtime repairs they depend on.

MiniMax Code plugins are directories that mcode loads: a manifest, an optional MCP server, and
optional skills. Local plugins live at `~/.minimax/plugins/<name>/` and are enabled by presence
there.

## What is here

| Plugin | What it does |
| --- | --- |
| `mcode-chrome/` | Drive the user's **real, signed-in Chrome** from mcode — real logins, real tabs, the tab you already have open. |
| `mcode-agnes/` | Agnes AI image and video generation, using the credential pi already holds. |
| `mcode-codex/` | ChatGPT subscription (Codex) image generation and editing, using the credential pi already holds. |
| `mcode-retry-on-error/` | Continue a turn that ended in an error or a rate-limited tool call, with backoff. |
| `scripts/apply-mcode-rm-shim-fix.mjs` | Repairs a broken recoverable-delete shim in `@minimax-ai/code` 0.6.12. See [Runtime repair](#runtime-repair). |
| `scripts/apply-mcode-llm-retry-policy.mjs` | Raises the provider retry budget to six hours and makes spent quotas retryable. See [Runtime repair](#runtime-repair-the-provider-retry-budget). |
| `shared/` | The retry core, the MCP stdio server and the workspace resolver, copied into each plugin that uses them. |

## Install

```bash
scripts/install-plugin.sh mcode-chrome
scripts/install-plugin.sh mcode-agnes
scripts/install-plugin.sh mcode-codex
scripts/install-plugin.sh mcode-retry-on-error
```

The installer copies the plugin to `~/.minimax/plugins/<name>/` and registers it with the local
marketplace. Local plugins are enabled by presence in that folder — `mcode plugin add -m local`
rejects a re-install of a plugin that is already there, so the script checks the list first.

Verify with `mcode plugin list`.

## The retry policy

The image plugins share one retry core (`shared/retry.mjs`), and the behaviour is deliberate:

- **15 attempts**, each a little later than the last — roughly two to three minutes in total
- retried: 429, 408, 5xx, timeouts, dropped connections, `fetch failed`
- a server's `Retry-After` is honoured
- **not** retried: 400, 401, 403, 404, 422 — a bad request or a bad credential will fail
  identically every time, and looping on it just burns quota
- exponential backoff with jitter, so several agents hitting the same limit do not resynchronise

The image plugins are the reason this exists: the ChatGPT subscription has its own quota and will
answer 429 under load, and a task that dies on the first 429 is worse than one that waits.

`mcode-retry-on-error` is a different mechanism for the same goal: it works at the *tool* and *turn*
level, so it also covers failures in tools that have no retry policy of their own.

### What the retry plugin can and cannot reach

It has two hooks. `PostToolUse` fires the instant a tool fails and injects a retry instruction
into the tool result, while the model is still working. `Stop` is the backstop for a turn that
tried to end in an error.

**Provider rate limits are not reachable by any plugin, and mcode already handles them.** The
`The model provider is rate limiting requests. Code: 50150` error never reaches the session
transcript, and the `Stop` hook never fires for it — the run aborts before a turn completes.

Measured: across 7,185 assistant messages in a day's transcripts, the `stopReason` is only ever
`toolUse` or `stop` — never `error` — and the provider error string appears in no transcript at
all. Forcing a provider failure with an unreachable endpoint confirmed it: the run failed and the
hook never ran.

mcode's own retry of that layer had a hardcoded budget of five — about half a minute of waiting, then
the turn dies. It is raised to six hours by `scripts/apply-mcode-llm-retry-policy.mjs` — see
[Runtime repair](#runtime-repair-the-provider-retry-budget).

## Credentials

`mcode-agnes` and `mcode-codex` read the credential **pi already has**, from
`~/.pi/agent/auth.json`:

| Plugin | Key in pi's store | Environment override |
| --- | --- | --- |
| `mcode-agnes` | `agnes` | `AGNES_API_KEY`, `AGNES_CN_API_KEY` |
| `mcode-codex` | `openai-codex` | `CODEX_IMAGE_ACCESS_TOKEN`, `CODEX_IMAGE_ACCOUNT_ID` |

One login, two agents. The codex plugin refreshes an expired token in memory and does **not** write
back to pi's auth file, so it cannot corrupt another tool's state.

## Test

```bash
node scripts/retry-test.mjs                        # the retry policy
node scripts/workspace-test.mjs                    # the workspace directory resolver
node scripts/sync-shared.mjs --check               # shared modules in sync
node mcode-chrome/scripts/server-mode-test.mjs     # standalone protocol round trip
node mcode-chrome/scripts/smoke-test.mjs           # MCP handshake against the live bridge
node mcode-agnes/scripts/smoke-test.mjs            # status only, no credits spent
node mcode-agnes/scripts/smoke-test.mjs --generate # also generate one real image
node mcode-codex/scripts/smoke-test.mjs            # status only, no credits spent
node mcode-codex/scripts/smoke-test.mjs --generate # also generate one real image
node mcode-retry-on-error/scripts/hook-test.mjs    # the Stop hook decisions
node mcode-retry-on-error/scripts/post-tool-hook-test.mjs # the PostToolUse decisions
node scripts/verify-mcode-retry-classifier.mjs      # the installed provider classifier
```

Regenerate the plugin manifests after changing any tool definition:

```bash
node mcode-agnes/scripts/build-manifest.mjs
node mcode-codex/scripts/build-manifest.mjs
node mcode-chrome/scripts/build-manifest.mjs
```

## Runtime repair

`@minimax-ai/code` 0.6.12 seeds a recoverable-delete shim at `<dataDir>/shims/rm` and puts it
ahead of `/bin/rm` on the agent's PATH, so every delete lands in the platform trash instead of
being unlinked. The shim is generated from a template in the mcode bundle whose shebang is
hardcoded to `#!/bin/bash`.

This machine is Nix-based and has no `/bin/bash` — bash lives at
`/run/current-system/sw/bin/bash`. The shim therefore could not exec at all, and **every `rm` in
agent bash failed**:

```
/home/dracon/.minimax/shims/rm: /bin/bash: bad interpreter: No such file or directory
```

The fix is one line in the bundle template: `#!/usr/bin/env bash`, which resolves bash through
PATH on both Nix-style and conventional systems. The app re-seeds the on-disk shim whenever it
differs from the template, so patching the template is what makes the fix stick.

```bash
node scripts/apply-mcode-rm-shim-fix.mjs           # patch the template and re-seed the shim
node scripts/apply-mcode-rm-shim-fix.mjs --check   # report only, no writes
```

`mcode update` replaces the bundle wholesale, so re-run the script afterwards. The script is
idempotent and safe to run at any time.

## Runtime repair: the provider retry budget

MiniMax Code retries a rate-limited provider request itself, but the budget is a hardcoded
constant in the bundle:

```js
{maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30000, maxRetryElapsedMs: 120000}
```

Five retries means six attempts over about twenty seconds of waiting, then the turn dies. There is
no way to configure it: the policy is merged in by `Gpn(t.policy)`, but `t.policy` never arrives —
the only caller that supplies `resolveLlmRetry` hands back an observer and nothing else, and there
is no config key or environment variable for it anywhere in the bundle.

`scripts/apply-mcode-llm-retry-policy.mjs` patches the constant so the retry survives a quota
window rather than a momentary burst:

```js
{maxRetries: 200, baseDelayMs: 1500, maxDelayMs: 300000, maxRetryElapsedMs: 21600000}
```

The first few attempts stay close together, so a rate limit that clears in seconds is caught
almost immediately. The delay then doubles up to a five-minute cap, and the loop keeps going for
**six hours** — long enough to outlast a quota that takes hours to reset. The attempt count is a
backstop; the wall clock is what actually binds.

```bash
node scripts/apply-mcode-llm-retry-policy.mjs           # patch it
node scripts/apply-mcode-llm-retry-policy.mjs --check   # report only, no writes
node scripts/apply-mcode-llm-retry-policy.mjs --revert  # back to MiniMax Code's default
node scripts/verify-mcode-retry-classifier.mjs          # test the installed classifier
```

Measured against a local endpoint that always answers 429:

| Policy | Attempts | Gaps between attempts | Wall clock |
| --- | --- | --- | --- |
| Stock | 6 | 1s, 2s, 4s, 8s, 16s | ~20s |
| Patched | ~100 | 1.5s, 3s, 6s, 12s, 24s, 48s, 96s, 192s, then 5min | 6h |

The original chunk is kept as `<chunk>.orig.bak` beside it, and the script refuses to overwrite a
policy it does not recognise. `mcode update` replaces the bundle wholesale, so re-run the script
afterwards — the same caveat as the shim fix.

This is a policy change to a third-party install, not a bug fix. It is the only lever that exists:
the provider error never reaches a plugin hook, so no plugin can add retries at that layer.

### Which provider errors this covers

The error in the screenshots is `Code: 50150`, which is `LLM_TPM_RATE_LIMITED` — a token-per-minute
limit. The retry classifier treats it as **retryable**, so the budget above governs it.

Two neighbouring codes were hardcoded as **terminal**, which meant no retry, no backoff and an
instant dead turn:

| Code | Meaning | Before | Now |
| --- | --- | --- | --- |
| 50150 | `LLM_TPM_RATE_LIMITED` | retried | retried |
| 50111 | `LLM_RATE_LIMITED` | retried | retried |
| 50151 | `LLM_CLUSTER_OVERLOADED` | retried | retried |
| 42212 | `USAGE_LIMIT_EXCEEDED` | **terminal** | retried |
| 50110 | `LLM_CREDITS_EXHAUSTED` | **terminal** | retried |
| 5xx | a server error | **terminal** | retried |
| 50112 | `LLM_AUTH_ERROR` (401/403) | terminal | terminal |
| — | a content filter, a refusal, a bad request, an explicit abort | terminal | terminal |

A spent quota is the case that matters most here: it resets on a timer, and MiniMax Code was
giving up on the first response instead of waiting for it. The same script patches the classifier
so those codes take the retry path, and a plain 5xx with them — MiniMax Code retried 429 and 529
but gave up on 500, 502 and 504, which is stranger still.

An authentication failure stays terminal on purpose. A bad credential will not fix itself, and
retrying it for six hours is pointless.

`scripts/verify-mcode-retry-classifier.mjs` tests the classifier that is actually installed: it
pulls the function out of the live bundle and runs it against realistic error facts. That is the
only way to cover the managed provider path — MiniMax Code marks BYOK providers as "retry every
error", so a custom provider never reaches the classifier at all.

## Known gap: none outstanding

The `mcode-retry-on-error` plugin installs a `Stop` hook that blocks a failed turn and feeds a
retry instruction back to the model. It works: the hook runs on every turn end, and its
`{"decision": "block", "reason": "..."}` output arrives at the model wrapped in
`<plugin-hook-context>`, which continues the turn.

One thing is easy to get wrong when working on it: the hook's data directory is
`~/.minimax/v2/plugin-data/hooks/<plugin-name>/`, **not** a `.plugin-data` folder next to the
plugin. Configuration and state live there, and the heartbeat log in that directory is how you
confirm the hook is running.

The retry behaviour that does *not* need any hook support is the call-level one in
`shared/retry.mjs`, used by the image plugins.

## Conventions

- **Licence.** This repository is AGPL-3.0. Plugins declare the same licence. Code reused from
  MIT-licensed upstream projects stays under its own licence and is attributed in the plugin
  README.
- **No vendored bundles.** A stale copy of a 6 MB upstream bundle does not belong in the history.
  Repair upstream tooling with a small, re-runnable script instead, and gitignore the artefacts
  (`*.orig.bak`).
- **Zero runtime dependencies.** Plugins run from a plain `node` executable with no
  `node_modules`, so they can be copied anywhere mcode runs.
- **Shared code is generated, not hand-copied.** `shared/` holds the single copy of the retry core,
  the MCP server and the workspace resolver; `scripts/sync-shared.mjs` copies it into each plugin and
  `--check` fails if they have drifted.
- **Manifests are generated, not hand-written.** Each plugin has a `scripts/build-manifest.mjs` that
  derives `mcp/<server>.mcp.json` from the tool definitions in `server/tools.mjs`, so the declared
  tool list can never drift from the running server. Run all three after changing a tool:
  `node mcode-agnes/scripts/build-manifest.mjs && node mcode-codex/scripts/build-manifest.mjs && node mcode-chrome/scripts/build-manifest.mjs`.
- **Relative paths resolve against the workspace, not the home directory.** MiniMax Code spawns
  plugin MCP servers with the *home* directory as their working directory and passes no workspace
  path in the environment, so a relative `savePath` would land in `~/…`. `shared/workspace.mjs`
  resolves the workspace instead — `MCODE_WORKSPACE` if it is set, otherwise `PWD`, which is the
  directory mcode was launched from — and every path-taking tool also accepts an explicit
  `baseDir`. Absolute paths always work and are preferred.

