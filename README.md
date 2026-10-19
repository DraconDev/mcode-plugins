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
| `shared/` | The retry core and the MCP stdio server, copied into each plugin that uses them. |

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
MiniMax Code retries that layer itself (5 attempts over 2 minutes, shown as
`Retrying model request · 3/5`), then points at `/retry`, and the goal runtime parks the session
as `Usage limited — Resume after provider access recovers`.

Measured: across 7,185 assistant messages in a day's transcripts, the `stopReason` is only ever
`toolUse` or `stop` — never `error` — and the provider error string appears in no transcript at
all. Forcing a provider failure with an unreachable endpoint confirmed it: the run failed and the
hook never ran.

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

