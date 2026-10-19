# Contributing

Thanks for looking at this. A few conventions keep it working, and they are all cheap to follow.

## Ground rules

- **Zero runtime dependencies.** The plugins run from a plain `node` executable with no
  `node_modules`, so they can be copied anywhere mcode runs. Do not add a dependency to a plugin's
  `server/` directory.
- **Plain Node, not TypeScript.** No build step, no transpile, no bundler.
- **Do not vendor upstream bundles.** A 6 MB copy of someone else's code does not belong in the
  history. If MiniMax Code ships something broken, ship a small re-runnable script that repairs it
  in place — see `scripts/apply-mcode-rm-shim-fix.mjs` — and gitignore the artefacts.

## Before you open a pull request

Run these. They all need nothing but Node:

```bash
node scripts/retry-test.mjs
node scripts/workspace-test.mjs
node scripts/sync-shared.mjs --check
node mcode-chrome/scripts/server-mode-test.mjs
node mcode-retry-on-error/scripts/hook-test.mjs
node mcode-retry-on-error/scripts/post-tool-hook-test.mjs
```

The two smoke tests that need a real browser or a real credential are not part of the loop:

```bash
node mcode-chrome/scripts/smoke-test.mjs status   # needs the Chrome extension polling
node mcode-agnes/scripts/smoke-test.mjs            # needs a credential
node mcode-codex/scripts/smoke-test.mjs            # needs a credential
```

CI runs the same list on every push and fails if a generated file is out of date.

## Generated files

Two things in this repository are generated. Do not hand-edit them.

**`shared/` is the source of truth for the shared modules.** `shared/retry.mjs`,
`shared/mcp-server.mjs` and `shared/workspace.mjs` are copied into every plugin that has an MCP
server, because an installed plugin has to be self-contained. Edit `shared/`, then:

```bash
node scripts/sync-shared.mjs
```

Never edit a plugin's copy directly — the next sync will overwrite it. CI fails if they drift.

**The MCP manifests are generated from the tool definitions.** Each plugin's
`mcp/<server>.mcp.json` is derived from its `server/tools.mjs`, so the declared tool list can never
diverge from the running server. After changing a tool's name, description, schema or parameters:

```bash
node mcode-agnes/scripts/build-manifest.mjs
node mcode-codex/scripts/build-manifest.mjs
node mcode-chrome/scripts/build-manifest.mjs
```

CI regenerates them and fails on any diff.

## Writing a tool

- Keep the tool definition in `server/tools.mjs` as an entry in the module-level `TOOL_DEFS` array,
  with a `handler(args, ctx)` and a schema. The manifest builder reads the same array, so a tool
  that is not in `TOOL_DEFS` is not in the manifest either.
- A path-taking tool must resolve against the workspace, not the home directory. mcode spawns
  plugin MCP servers with the *home* directory as their working directory, so `shared/workspace.mjs`
  exists to find the real one. See `resolveWorkspaceDir()` and `resolveAgainst()`.
- Anything that reaches the network goes through the shared retry core, not a hand-rolled loop.
- **Never log, echo or return a credential** — not in a tool result, not in an error message, not
  in a log line. If a failure needs to be explained, describe the shape of the problem, not the
  value.
- Redact anything that came from a browser before it reaches the tool result. `mcode-chrome`'s
  `redact()` is the reference: it must handle the shapes the extension actually produces, not the
  shapes you wish it produced.

## Writing a hook

- A `Stop` hook may return `{"decision":"block","reason":"…"}` to continue a turn.
- A `PostToolUse` hook **must not** return a top-level `decision`. MiniMax Code treats a blocked
  `PostToolUse` as a structured block, which closes the tool-result delivery seam and makes the
  *next* tool call fail with `Tool-result delivery seam is closed.` Use
  `hookSpecificOutput {hookEventName:"PostToolUse", additionalContext}` instead.
- A hook must never wedge a session. Wrap the entry point so a throw exits 0 and logs to stderr.
- The hook's data directory is `~/.minimax/v2/plugin-data/hooks/<plugin-name>/`, **not** a
  `.plugin-data` folder next to the plugin.
- Only retry *transient* failures. A validation error, a permission denial, a missing file, an
  authentication failure, a content filter — retrying those just burns the user's time and quota.

## Fixing a bug

Add a test that fails without your fix and passes with it. The suites are plain scripts that print
`PASS`/`FAIL` per check and exit non-zero on failure — match that style, and put the test next to
the thing it covers:

| Area | Test |
| --- | --- |
| the shared retry core | `scripts/retry-test.mjs` |
| the workspace resolver | `scripts/workspace-test.mjs` |
| the `Stop` hook | `mcode-retry-on-error/scripts/hook-test.mjs` |
| the `PostToolUse` hook | `mcode-retry-on-error/scripts/post-tool-hook-test.mjs` |
| the Chrome bridge protocol | `mcode-chrome/scripts/server-mode-test.mjs` |

A defect that was found by a manual reproduction should be reproducible by a test. That is how it
stays fixed.

## Style

Match the file you are editing. The house style is:

- Two-space indent, semicolons, single quotes.
- `JSDoc` comments that explain **why**, not what. The code says what it does; the comment should
  say what would break without it, and what was tried first.
- Comments in the same voice as the existing ones — plain, concrete, occasionally dry.

## Licence

This repository is AGPL-3.0-or-later. Code reused from MIT-licensed upstream projects stays under
its own licence and is attributed in the plugin README.
