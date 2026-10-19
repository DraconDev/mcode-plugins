# mcode-chrome

A MiniMax Code plugin that gives mcode access to the user's **real, signed-in Chrome** — the same
browser, the same profile, the same logins — the way [pi](https://github.com/tianrendong/pi) and
muse already do.

It reuses the `Pi Chrome Connector` companion extension and the pi-chrome loopback bridge. Nothing
is re-launched, nothing is re-logged-in, and the user's cookies are the user's cookies.

## How it works

```
MiniMax Code ──MCP (stdio)──> mcode-chrome server ──HTTP 127.0.0.1:17318──> Pi Chrome Connector ──> real Chrome
```

The MCP server is the plugin's only moving part. It speaks the pi-chrome wire protocol and has two
modes:

- **server** — it owns the loopback port and brokers commands to the extension.
- **client** — another session (typically a running `pi`) already owns the port, so commands are
  forwarded to that owner.

The mode is decided at startup and re-decided if the owner disappears, so mcode and pi can drive
the same browser at the same time without fighting over the port. `mcp__chrome__status` reports
which mode is in play.

Each session also gets its own **automation tab**, grouped as `MCode Session: <id>`. Tools with no
explicit target act on that tab, so the user's currently active tab is never navigated, overwritten,
or closed by accident.

## Install

```bash
# from a checkout of this repository
scripts/install-plugin.sh mcode-chrome
# or, from inside the plugin's own directory
bash mcode-chrome/scripts/install.sh
```

That copies the plugin to `~/.minimax/plugins/mcode-chrome` and registers it with the local
marketplace. Verify with:

```bash
mcode plugin list
```

The plugin needs `node` on `PATH` (the MCP server is launched as `node ./server/main.mjs`) and the
`Pi Chrome Connector` extension loaded in the Chrome profile you want to drive. The extension ships
with [`pi-chrome`](https://www.npmjs.com/package/pi-chrome) (MIT):

```bash
npm install -g pi-chrome
```

This plugin deliberately does **not** bundle a copy of the extension, because a Chrome extension's
id is derived from the unpacked folder's path — a second copy would register as a second connector
and race the first one for commands. If the extension is not loaded, `mcp__chrome__status` prints
the exact folder to select at `chrome://extensions` → "Load unpacked".

## Tools

The MCP server is named `chrome`, so tools are `mcp__chrome__<tool>`.

| Tool | Purpose |
| --- | --- |
| `status` | Bridge health, extension connection, authorization state. |
| `authorize` / `revoke` | Unlock / lock the tools that change the page. |
| `tab` | List, open, activate, close, group tabs. |
| `snapshot` | Read the page: structure, actions, forms, text, changes. |
| `find` | Locate elements or text by natural-language query. |
| `inspect` | Deep-dive one element: nearby text, form context, ancestors. |
| `navigate` | Load a URL. |
| `evaluate` | Run JavaScript in the page (MAIN world, CSP-safe). |
| `click`, `type`, `fill`, `key` | Act on the page. |
| `hover`, `drag`, `tap`, `scroll` | Pointer and touch input. |
| `wait_for` | Wait for a selector or a truthy expression. |
| `console_messages` | Captured console output. |
| `network_requests`, `network_request` | Captured XHR/fetch traffic and bodies. |
| `screenshot` | Capture the page; the image is returned inline. |
| `upload_file` | Attach local files to a file input. |

`snapshot`, `find`, `inspect`, `console_messages`, `network_requests` and read-only `evaluate` are
read-only and always available. The rest need authorization.

## Authorization

The loopback bridge trusts any local process, so the plugin carries the gate that `/chrome
authorize` carries in pi.

- **Default: authorized.** This matches the posture already chosen for pi on this machine
  (`pi-chrome-auto-auth` pins pi's gate to indefinite). The user installed this plugin to give the
  agent browser access.
- `mcp__chrome__authorize` takes a duration — `indefinite` or a number of minutes.
- `mcp__chrome__revoke` locks actuation. Read-only tools keep working.

The decision is persisted in `~/.minimax/plugin-data/mcode-chrome/auth.json` (override with
`MCODE_CHROME_DATA_DIR`). To lock the plugin by default, write `{"until": 0}` into that file.

The `skills/chrome-browser/SKILL.md` skill adds the second layer: read-only first, explicit
confirmation before actuating on a page, and secret-handling rules for a browser full of
credentials.

## Security posture

Mirrors pi-chrome deliberately:

- The listener binds to `127.0.0.1` only — no network exposure.
- `/command` is accepted only from a local process (no `Origin`, no `sec-fetch-site`).
- `/next` and `/result` are accepted only from a `chrome-extension://` origin.
- Output is redacted before it is printed: secret-shaped keys lose their values, data URLs are
  elided, long strings are truncated.

Page content still reaches the model, exactly as in pi-chrome. The skill tells the agent to say so
when the user asks it to work on a sensitive page.

## Development

```bash
node scripts/build-manifest.mjs      # regenerate mcp/chrome.mcp.json from server/tools.mjs
node scripts/server-mode-test.mjs     # standalone: own the port, mock companion, full protocol round trip
node scripts/smoke-test.mjs           # initialize, tools/list, status, tab, snapshot
node scripts/e2e-test.mjs [url]       # navigate + snapshot + find + evaluate + console + screenshot
```

`build-manifest` exists so the declared tool list in the plugin manifest can never drift from the
running server: both are generated from `server/tools.mjs`.

`server-mode-test.mjs` covers the branch a live test cannot reach while another session owns the
port: it starts the bridge as the owner, runs a mock companion that speaks the real wire protocol
against it, and asserts the `/next` → command → `/result` round trip, the session key on the wire,
and that a companion-side failure rejects with its reason.

The server has **zero dependencies** — it runs on a plain `node` executable with nothing installed
alongside it. It imports only `node:http`, `node:fs`, `node:path`, `node:os`, and `node:crypto`.

## What is ours, and what is borrowed

This is a standalone mcode plugin, not a wrapper around pi.

**Ours** — everything mcode actually runs:

- the plugin manifest, the MCP server, the 23 tools, the skill
- the authorization gate, the redaction and snapshot formatting
- session scoping and the `MCode Session: <id>` tab group
- the owner-or-client port logic, written from scratch for this plugin

`server/` imports nothing but Node built-ins. There is no `node_modules`, no import of
`pi-chrome`, and no dependency on the pi runtime. The single functional reference to pi-chrome is
a *path lookup* used only to print "load the extension from here" in `status` when the connector
is not yet running.

**Borrowed** (MIT, from [pi-chrome](https://github.com/tianrendong/pi-chrome)):

- the wire protocol's shape — four endpoints, the same command/result envelope
- the companion extension itself, which is installed on this machine already

**Shared at runtime:** the loopback port. If a `pi` session is running it owns 127.0.0.1:17318 and
this plugin forwards commands to it; with no pi session running the plugin owns the port itself
and brokers commands to the extension directly. Both paths are tested, and neither requires pi to
exist.


## Paths

`screenshot` (`path`) and `upload_file` (`paths`) take local paths. A relative path resolves
against the **agent workspace** — the directory mcode was launched from — because MiniMax Code
spawns plugin MCP servers with the home directory as their working directory and passes no
workspace path in the environment. An absolute path is unambiguous and preferred; `baseDir`
overrides the base directory for a relative path.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `MCODE_CHROME_BRIDGE_HOST` | Bridge host (default `127.0.0.1`). |
| `MCODE_CHROME_BRIDGE_PORT` | Bridge port (default `17318`). |
| `MCODE_CHROME_BRIDGE_URL` | Force client mode against a specific URL. Debugging only. |
| `MCODE_CHROME_EXTENSION_PATH` | Path to the companion extension folder to report in `status`. |
| `MCODE_CHROME_DATA_DIR` | Where the authorization state is persisted. |
| `MCODE_SESSION_ID` | Stable session id; defaults to a hash of the workspace directory. |
| `MCODE_WORKSPACE` | Overrides the workspace directory that relative paths resolve against. |

## Environment note: the `rm` shim in MiniMax Code 0.6.12

While building this, a pre-existing bug in `@minimax-ai/code` 0.6.12 surfaced on this machine.

MiniMax Code seeds a recoverable-delete shim at `<dataDir>/shims/rm` and puts it ahead of `/bin/rm`
on the agent's PATH. The shim is generated from a template in
`chunks/chunk-5ADYFF2U.js` whose shebang is hardcoded to `#!/bin/bash`. This system is Nix-based
and has no `/bin/bash` (bash lives at `/run/current-system/sw/bin/bash`), so **every `rm` in agent
bash failed** with `bad interpreter: No such file or directory` — deletes never reached the trash.

There is no newer published version, so the template was patched to use `#!/usr/bin/env bash`,
which resolves through PATH on both Nix and conventional systems:

```bash
# in @minimax-ai/code/chunks/chunk-5ADYFF2U.js
var qur = `#!/usr/bin/env bash
# Managed by MiniMax Code. Do not edit.
...
```

The app re-seeds the shim whenever the on-disk content differs from the template, so the fix
applies from the next session start.

Rather than committing a 6 MB stale copy of the bundle, the repo ships an idempotent repair
script — run it after `mcode update` if the shim starts failing again:

```bash
node scripts/apply-mcode-rm-shim-fix.mjs           # patch and re-seed
node scripts/apply-mcode-rm-shim-fix.mjs --check   # report only
```

This plugin does not depend on the fix — `scripts/install.sh` removes the old plugin copy with
node rather than `rm`, so it works either way.

## Layout

```
mcode-chrome/
├── .minimax-plugin/plugin.json   plugin manifest
├── mcp/chrome.mcp.json            MCP server declaration (generated)
├── server/
│   ├── main.mjs                   MCP stdio server
│   ├── bridge.mjs                 loopback bridge, owner-or-client
│   ├── tools.mjs                  tool definitions and handlers
│   ├── format.mjs                 snapshot rendering, redaction
│   ├── auth.mjs                   authorization gate
│   ├── session.mjs                session key and tab group
│   ├── mcp-server.mjs             shared MCP stdio server (generated copy)
│   ├── retry.mjs                  shared retry core (generated copy)
│   └── workspace.mjs              shared workspace resolver (generated copy)
├── skills/chrome-browser/SKILL.md agent workflow and safety rules
└── scripts/                       manifest builder, tests, installer
```

## License

AGPL-3.0-or-later, matching this repository. The wire protocol and the companion extension come
from [pi-chrome](https://github.com/tianrendong/pi-chrome) (MIT); the MIT-licensed protocol is
reimplemented here rather than vendored.
