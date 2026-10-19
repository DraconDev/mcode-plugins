# mcode-plugins

MiniMax Code plugins for this machine, plus the small runtime repairs they depend on.

MiniMax Code plugins are directories that mcode loads: a manifest, an optional MCP server, and
optional skills. Local plugins live at `~/.minimax/plugins/<name>/` and are registered with the
`local` marketplace.

## What is here

| Path | What it is |
| --- | --- |
| `mcode-chrome/` | Drive the user's **real, signed-in Chrome** from mcode — real logins, real tabs, the tab you already have open. |
| `scripts/apply-mcode-rm-shim-fix.mjs` | Repairs a broken recoverable-delete shim in `@minimax-ai/code` 0.6.12. See [Runtime repair](#runtime-repair). |

## mcode-chrome

mcode ships a Host-backed **in-app** Browser (`browser-use`, installed by default). It is a
separate sandboxed browser — not your Chrome, so not your logins, tabs, or profile.

`mcode-chrome` fills that gap. It speaks the same loopback wire protocol as
[pi-chrome](https://github.com/tianrendong/pi-chrome), so it reuses the `Pi Chrome Connector`
extension already installed in your normal Chrome profile. No second browser is launched, nothing
is re-logged-in, and your cookies are your cookies.

```
MiniMax Code ──MCP (stdio)──> mcode-chrome server ──HTTP 127.0.0.1:17318──> Pi Chrome Connector ──> your Chrome
```

The MCP server is **owner-or-client**: it takes the loopback port when free, or forwards commands
to whichever session already owns it. mcode and pi can drive the same browser at once, and
whichever starts first brokers for the other. Each session also gets its own automation tab,
grouped as `MCode Session: <id>`, so your active tab is never hijacked.

23 tools are exposed as `mcp__chrome__*` — `status`, `tab`, `snapshot`, `find`, `inspect`,
`navigate`, `evaluate`, `click`, `type`, `fill`, `key`, `hover`, `drag`, `tap`, `scroll`,
`wait_for`, `console_messages`, `network_requests`, `network_request`, `screenshot`,
`upload_file`, plus `authorize` / `revoke`. The `mcode-chrome:chrome-browser` skill covers the
workflow, the authorization discipline, and secret handling.

Full details, including what is ours versus what is borrowed from pi-chrome, are in
[`mcode-chrome/README.md`](mcode-chrome/README.md).

### Install

```bash
bash mcode-chrome/scripts/install.sh
mcode plugin list          # expect: mcode-chrome@local  enabled
```

The install script copies the plugin to `~/.minimax/plugins/mcode-chrome/` and registers it with
the local marketplace. Local plugins are enabled by presence in that folder — `mcode plugin add
-m local` rejects a re-install of a plugin that is already there, so the script checks the list
first and only adds when needed.

### Test

```bash
node mcode-chrome/scripts/server-mode-test.mjs   # standalone protocol round trip
node mcode-chrome/scripts/smoke-test.mjs         # MCP handshake against the live bridge
node mcode-chrome/scripts/e2e-test.mjs           # navigate + snapshot + find + evaluate + screenshot
```

`server-mode-test.mjs` runs the bridge as the port owner against a mock companion extension, so
it covers the branch a live test cannot reach while another session owns the port. It is the
proof that the plugin does not depend on pi being installed or running.

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

## Conventions

- **Licence.** This repository is AGPL-3.0. Plugins declare the same licence. Code reused from
  MIT-licensed upstream projects stays under its own licence and is attributed in the plugin
  README.
- **No vendored bundles.** A stale copy of a 6 MB upstream bundle does not belong in the history.
  Repair upstream tooling with a small, re-runnable script instead, and gitignore the artefacts
  (`*.orig.bak`).
- **Zero runtime dependencies.** Plugins run from a plain `node` executable with no
  `node_modules`, so they can be copied anywhere mcode runs.
- **The manifest is generated.** `mcode-chrome/scripts/build-manifest.mjs` derives
  `mcp/chrome.mcp.json` from `server/tools.mjs`, so the declared tool list can never drift from
  the running server. Re-run it after changing the tool set.
