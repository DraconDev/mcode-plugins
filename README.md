# mcode-plugins

Plugins for [MiniMax Code](https://github.com/minimax-ai/code) (`@minimax-ai/code`) that give it
three things it does not ship with: a browser it can actually drive, image and video generation,
and a retry policy that does not give up after half a minute.

Everything here is plain Node — no `node_modules`, no build step, no framework. Clone it, run one
script, and the plugins are installed.

| Plugin | What it does |
| --- | --- |
| [`mcode-chrome/`](mcode-chrome/) | Drive the user's **real, signed-in Chrome** — real logins, real tabs, the tab already open. 23 tools. |
| [`mcode-agnes/`](mcode-agnes/) | Agnes AI image and video generation. Set one environment variable. 3 tools. |
| [`mcode-codex/`](mcode-codex/) | ChatGPT-subscription (Codex) image generation and editing. Set one environment variable. 2 tools. |
| [`mcode-retry-on-error/`](mcode-retry-on-error/) | Continue a turn that ended in an error or a rate-limited tool call, with backoff. Hook-based, no tools. |

---

## Requirements

- **Node 18 or newer** — the plugins use `fetch` and `AbortSignal.timeout`. Check with `node --version`.
- **MiniMax Code 0.6.12 or newer** — the manifest format (`schemaVersion: 1`) and the hook events
  these plugins use are that version's.
- **`mcode` on `PATH`** — for the install script to register the plugin.
- For `mcode-chrome` only: the **Pi Chrome Connector** browser extension, loaded into your normal
  Chrome profile. See [`mcode-chrome/README.md`](mcode-chrome/README.md).

## Install

```bash
git clone https://github.com/DraconDev/mcode-plugins.git
cd mcode-plugins
```

Then install one plugin, or all four:

```bash
scripts/install-plugin.sh mcode-chrome
scripts/install-plugin.sh mcode-agnes
scripts/install-plugin.sh mcode-codex
scripts/install-plugin.sh mcode-retry-on-error
```

```bash
# or all of them
for plugin in mcode-chrome mcode-agnes mcode-codex mcode-retry-on-error; do
  scripts/install-plugin.sh "$plugin"
done
```

The script copies the plugin to `~/.minimax/plugins/<name>/`, where local plugins are enabled by
presence, and registers it with the local marketplace. Verify with:

```bash
mcode plugin list
```

You should see each plugin as `enabled`. To update a plugin, re-run its install script — it replaces
the installed copy in place.

> Installing a plugin does not stop you from using mcode without it. Each one is independent; install
> only the ones you want.

## Credentials

Only the two image plugins need a credential. Each one takes an environment variable, and that is
all it needs — **no other tool has to be installed**:

| Plugin | Environment variable | What it is |
| --- | --- | --- |
| `mcode-agnes` | `AGNES_API_KEY` or `AGNES_CN_API_KEY` | your Agnes API key (the two cover the two Agnes regions) |
| `mcode-codex` | `CODEX_IMAGE_ACCESS_TOKEN` | the ChatGPT subscription's image OAuth access token. Add `CODEX_IMAGE_ACCOUNT_ID` if you want to be explicit about the account. |

```bash
export AGNES_API_KEY="…"
export CODEX_IMAGE_ACCESS_TOKEN="…"
```

Put them wherever you already keep environment variables — a shell profile, `direnv`, your
session manager. The plugin reads them at call time, so there is nothing to configure and no
restart to do.

### Sharing a login with pi

If you already use [pi](https://github.com/tianrendong/pi) and have signed in to Agnes or to the
Codex image provider there, these plugins will pick that credential up on their own from pi's auth
store (`~/.pi/agent/auth.json`) — one login, two agents, no environment variable to set. **pi is
not required**; the store is a convenience, not a dependency. When both are available the
environment variable wins.

The codex plugin refreshes an expired token **in memory only** and never writes back to pi's auth
file, so it cannot corrupt another tool's state. A token you supply yourself is never refreshed —
supply a fresh one when it expires.

`mcode-chrome` needs no credential of its own; it uses the session your Chrome extension already
has.

## The plugins

### `mcode-chrome` — drive your real browser

A MiniMax Code plugin that drives the **user's own Chrome** through a companion extension, rather
than a separate automation browser. That means the agent works inside the session you are already
signed in to, on the tabs you already have open.

```
status, authorize, revoke, tab, snapshot, find, inspect, navigate, evaluate,
click, type, fill, key, wait_for, console_messages, network_requests,
network_request, screenshot, hover, drag, tap, scroll, upload_file
```

Setup, the wire protocol, and the security posture are documented in
[`mcode-chrome/README.md`](mcode-chrome/README.md). The short version: load the extension, run
`mcode-chrome`'s `install.sh`, and keep that Chrome window open.

### `mcode-agnes` — Agnes AI images and video

```
status, generate_image, generate_video
```

Takes a prompt, optional reference images, and writes the result to disk. A `savePath` relative to
the workspace lands in the workspace; `baseDir` overrides the base. A video can be driven from
text-to-video, one keyframe, or two.

### `mcode-codex` — ChatGPT subscription images

```
status, generate_image
```

Generates from a prompt and up to five reference images, and can edit an existing picture in a
consistent style. The ChatGPT subscription has its own quota and will answer `429` under load —
which is why the retry policy below exists.

### `mcode-retry-on-error` — do not give up

Two hooks:

- **`PostToolUse`** fires the instant a tool fails, while the model is still working, and injects a
  retry instruction into the tool result.
- **`Stop`** is the backstop for a turn that tried to end in an error — it blocks the turn and feeds
  a retry instruction back to the model.

Both only act on *transient* failures. A validation error, a permission denial, a missing file, an
authentication failure, a content filter — those are terminal, and retrying them just burns the
user's time and quota. A rate limit, a timeout, a dropped connection, a `503` — those clear on
their own, so the plugin keeps trying.

## The retry policy

The image plugins share one retry core, [`shared/retry.mjs`](shared/retry.mjs):

- **16 attempts** — the first plus 15 retries — each a little later than the last, over roughly
  two to three minutes.
- **Retried:** 429, 408, 5xx, timeouts, dropped connections, `fetch failed`. A server's
  `Retry-After` is honoured.
- **Not retried:** 400, 401, 403, 404, 422 — a bad request or a bad credential fails identically
  every time.
- Exponential backoff with jitter, so several agents hitting the same limit do not resynchronise
  into a thundering herd.
- The total wall-clock budget is real: a delay is clamped to what is left of it, and no attempt
  starts after it has expired.

`mcode-retry-on-error` is a different mechanism for the same goal: it works at the tool and turn
level, so it also covers failures in tools that have no retry policy of their own.

### Provider rate limits are not reachable by a plugin

MiniMax Code retries a rate-limited provider request itself, and that error never reaches the
session transcript — the `Stop` hook does not fire for it, because the run aborts before a turn
completes. Measured: across 7,185 assistant messages in a day's transcripts, the `stopReason` is
only ever `toolUse` or `stop` — never `error`.

So the provider layer has to be repaired in the mcode bundle itself. See
[Runtime repair](#runtime-repair-the-provider-retry-budget) below.

## Runtime repair: the provider retry budget

**This is optional, and it patches a third-party install.** MiniMax Code retries a rate-limited
provider request with a hardcoded budget:

```js
{maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30000, maxRetryElapsedMs: 120000}
```

Five retries means six attempts over about twenty seconds of waiting, then the turn dies. There is
no way to configure it: the policy is merged in by a minified function, but the value it would
merge never arrives — there is no config key and no environment variable for it anywhere in the
bundle. The constant is the only lever.

`scripts/apply-mcode-llm-retry-policy.mjs` raises it to a budget that outlasts a quota window
rather than a momentary burst:

```js
{maxRetries: 200, baseDelayMs: 1500, maxDelayMs: 300000, maxRetryElapsedMs: 21600000}
```

The first few attempts stay close together, so a rate limit that clears in seconds is caught
almost immediately. The delay then doubles up to a five-minute cap, and the loop keeps going for
**six hours** — long enough to outlast a quota that takes hours to reset. The attempt count is a
backstop; the wall clock is what actually binds.

It also patches the classifier, so that a **spent quota**, **exhausted credits** and a plain
**5xx** are retried instead of being treated as terminal:

| Code | Meaning | Before | After |
| --- | --- | --- | --- |
| 50150 | `LLM_TPM_RATE_LIMITED` | retried | retried |
| 50111 | `LLM_RATE_LIMITED` | retried | retried |
| 50151 | `LLM_CLUSTER_OVERLOADED` | retried | retried |
| 42212 | `USAGE_LIMIT_EXCEEDED` | **terminal** | retried |
| 50110 | `LLM_CREDITS_EXHAUSTED` | **terminal** | retried |
| 5xx | a server error | **terminal** | retried |
| 50112 | `LLM_AUTH_ERROR` (401/403) | terminal | terminal |
| — | a content filter, a refusal, a bad request, an explicit abort | terminal | terminal |

An authentication failure stays terminal on purpose: a bad credential will not fix itself, and
retrying it for six hours is pointless.

```bash
node scripts/apply-mcode-llm-retry-policy.mjs           # patch it
node scripts/apply-mcode-llm-retry-policy.mjs --check   # report only, no writes
node scripts/apply-mcode-llm-retry-policy.mjs --revert  # back to MiniMax Code's default
node scripts/verify-mcode-retry-classifier.mjs          # test the installed classifier
```

The original chunk is kept as `<chunk>.orig.bak` beside it, and the script refuses to overwrite a
policy it does not recognise. `mcode update` replaces the bundle wholesale, so **re-run the script
afterwards** — that is the whole reason it is a script and not a patch file.

**Restart after patching.** Node reads the bundle into memory when a process starts, so a patch on
disk only reaches processes started afterwards. The script prints the sessions that are still
running the old code:

```
WARNING: 19 mcode processes are still running the old code.
  PID 3804772  started 2026-10-19 12:54:09
  The oldest has been up for 5h 26m.
  They keep the old budget — 5 retries, about half a minute — until restarted.
  Quit those sessions and start mcode again to pick up the new policy.
```

The same warning appears in `--check` mode.

## Runtime repair: the recoverable-delete shim

MiniMax Code seeds a recoverable-delete `rm` shim at `<dataDir>/shims/rm` and puts it ahead of
`/bin/rm` on the agent's PATH, so every delete lands in the platform trash instead of being
unlinked. The shim is generated from a template in the mcode bundle whose shebang is hardcoded to
`#!/bin/bash`.

On a Nix-based system — where bash lives at `/run/current-system/sw/bin/bash` and `/bin/bash` does
not exist — the shim cannot exec at all, and **every `rm` in agent bash fails**:

```
/home/dracon/.minimax/shims/rm: /bin/bash: bad interpreter: No such file or directory
```

`scripts/apply-mcode-rm-shim-fix.mjs` changes the template's shebang to `#!/usr/bin/env bash`,
which resolves bash through PATH on both Nix-style and conventional systems, and re-seeds the live
shim so the fix applies immediately.

```bash
node scripts/apply-mcode-rm-shim-fix.mjs           # patch the template and re-seed the shim
node scripts/apply-mcode-rm-shim-fix.mjs --check   # report only, no writes
```

## Development

### Test

Every plugin has a test script, and they all need nothing but Node:

```bash
node scripts/retry-test.mjs                        # the retry policy
node scripts/workspace-test.mjs                    # the workspace directory resolver
node scripts/mcp-server-test.mjs                   # the MCP stdio transport
node scripts/install-script-test.mjs               # the plugin installer
node scripts/sync-shared.mjs --check               # shared modules in sync
node mcode-chrome/scripts/server-mode-test.mjs     # standalone protocol round trip
node mcode-chrome/scripts/regression-test.mjs      # redaction, tab groups, screenshots
node mcode-agnes/scripts/path-safety-test.mjs      # path containment and image limits
node mcode-codex/scripts/path-safety-test.mjs      # path containment and image limits
node mcode-chrome/scripts/smoke-test.mjs           # MCP handshake against the live bridge
node mcode-agnes/scripts/smoke-test.mjs            # status only, no credits spent
node mcode-agnes/scripts/smoke-test.mjs --generate # also generate one real image
node mcode-codex/scripts/smoke-test.mjs            # status only, no credits spent
node mcode-codex/scripts/smoke-test.mjs --generate # also generate one real image
node mcode-retry-on-error/scripts/hook-test.mjs    # the Stop hook decisions
node mcode-retry-on-error/scripts/post-tool-hook-test.mjs # the PostToolUse decisions
node scripts/verify-mcode-retry-classifier.mjs      # the installed provider classifier
```

`--generate` spends real quota. The other two smoke tests only check the handshake and the
credential.

### Manifests are generated, not hand-written

Each plugin has a `scripts/build-manifest.mjs` that derives `mcp/<server>.mcp.json` from the tool
definitions in `server/tools.mjs`, so the declared tool list can never drift from the running
server. Run all three after changing a tool:

```bash
node mcode-agnes/scripts/build-manifest.mjs
node mcode-codex/scripts/build-manifest.mjs
node mcode-chrome/scripts/build-manifest.mjs
```

CI checks that regenerating them produces no diff.

### Shared code is generated, not hand-copied

`shared/` holds the single copy of the retry core, the MCP server and the workspace resolver. Each
plugin needs its own copy on disk because a plugin is installed by copying its directory somewhere
else entirely — it has to be self-contained. `scripts/sync-shared.mjs` keeps those copies identical:

```bash
node scripts/sync-shared.mjs           # copy shared/ into every plugin that has a server/
node scripts/sync-shared.mjs --check   # fail if they have drifted
```

**Never hand-edit** a plugin's copy of `retry.mjs`, `mcp-server.mjs` or `workspace.mjs` — edit
`shared/` and re-run the sync.

### Relative paths resolve against the workspace, not the home directory

MiniMax Code spawns plugin MCP servers with the *home* directory as their working directory and
passes no workspace path in the environment, so a relative `savePath` would land in `~/…`.
`shared/workspace.mjs` resolves the workspace instead — `MCODE_WORKSPACE` if it is set, otherwise
`PWD`, which is the directory mcode was launched from. Every path-taking tool also accepts an
explicit `baseDir`. Absolute paths always work and are preferred.

## Conventions

- **Licence.** AGPL-3.0-or-later. Each plugin declares the same licence. Code reused from
  MIT-licensed upstream projects stays under its own licence and is attributed in the plugin
  README.
- **Zero runtime dependencies.** Plugins run from a plain `node` executable with no
  `node_modules`, so they can be copied anywhere mcode runs.
- **No vendored bundles.** A stale copy of a 6 MB upstream bundle does not belong in the history.
  Repair upstream tooling with a small, re-runnable script instead, and gitignore the artefacts
  (`*.orig.bak`).
- **Shared code is generated.** See above.
- **Manifests are generated.** See above.
- **Tests for every fix.** A defect that was fixed gets a test that fails without the fix.

## Troubleshooting

**The plugin does not show up in `mcode plugin list`.**
Local plugins are enabled by presence in `~/.minimax/plugins/<name>/`. Check the directory exists
and contains `.minimax-plugin/plugin.json`. Then re-run the install script.

**A tool call fails with "Tool-result delivery seam is closed".**
Something is returning a top-level `{"decision":"block"}` from a `PostToolUse` hook. That form is
correct for the `Stop` hook and forbidden for `PostToolUse`, which must use
`hookSpecificOutput` with `additionalContext` instead.

**A rate limit still gives up after about half a minute.**
The session was started before the bundle patch. Node loads the bundle into memory at startup.
Run `node scripts/apply-mcode-llm-retry-policy.mjs --check` — it lists the sessions that are still
running the old code — and restart them.

**`rm` fails with "bad interpreter" in agent bash.**
The recoverable-delete shim was generated for a system with `/bin/bash`. Run
`node scripts/apply-mcode-rm-shim-fix.mjs`.

**The retry hook does not seem to fire.**
Its data directory is `~/.minimax/v2/plugin-data/hooks/mcode-retry-on-error/` — *not* a
`.plugin-data` folder next to the plugin. Set `"debug": true` in that directory's `config.json` and
the heartbeat log next to it will show every invocation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: keep it dependency-free, generate the
manifests, sync the shared modules, and add a test for anything you fix.

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).
