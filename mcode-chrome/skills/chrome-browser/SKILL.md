---
name: chrome-browser
description: >-
  Drive the user's real, signed-in Chrome through the Pi Chrome Connector companion extension —
  real logins, real tabs, real cookies, no separate automation browser. Use when the user asks to
  open, read, inspect, click, type into, screenshot, or debug a page in their own browser, or
  mentions "my browser", "the tab I have open", "logged in", or a page only a signed-in session can
  reach. This is the user's own Chrome, not the in-app browser; do not use it for that surface.
---

# Chrome Browser

Control the Chrome the user already runs — the same browser, the same profile, the same logged-in
sessions — through the companion extension `Pi Chrome Connector` and its loopback bridge on
`127.0.0.1:17318`. No second browser is launched, nothing is re-logged-in, and the user's
cookies are the user's cookies.

Tools are exposed by this plugin's MCP server, which is named `chrome`. Every call is
`mcp__chrome__<tool>`:

| Tool | Use it for |
| --- | --- |
| `mcp__chrome__status` | Bridge health, extension connection, authorization state. Start here. |
| `mcp__chrome__authorize` | Unlock tools that change the page. |
| `mcp__chrome__revoke` | Lock them again. |
| `mcp__chrome__tab` | List / open / activate / close / group tabs. |
| `mcp__chrome__snapshot` | Read the page: structure, actions, form fields, text, recent changes. |
| `mcp__chrome__find` | Find elements or text by a natural-language query. |
| `mcp__chrome__inspect` | Deep-dive one element: nearby text, form context, ancestors. |
| `mcp__chrome__navigate` | Load a URL in a tab. |
| `mcp__chrome__evaluate` | Run JavaScript in the page (MAIN world, CSP-safe). |
| `mcp__chrome__click` / `type` / `fill` / `key` | Act on the page. |
| `mcp__chrome__hover` / `drag` / `tap` / `scroll` | Pointer and touch input. |
| `mcp__chrome__wait_for` | Wait for a selector or a truthy expression. |
| `mcp__chrome__console_messages` | Captured console output. |
| `mcp__chrome__network_requests` / `network_request` | Captured XHR/fetch traffic and bodies. |
| `mcp__chrome__screenshot` | Capture the page; the image comes back inline. |
| `mcp__chrome__upload_file` | Attach local files to a file input. |

## This is not the in-app browser

MiniMax Code also ships a Host-backed **in-app** Browser (`browser-use`). That is a separate
surface with its own session. Use it when the user talks about the in-app, embedded, right-side,
or FilePanel browser. Use **this** skill when they talk about their own browser, the tab they have
open, or a page behind a login. If the request names a browser surface explicitly, that choice wins.

## Session startup

1. Call `mcp__chrome__status` once.
   - `extension: not polling` → the connector is not running. The tool output includes the exact
     folder to load; tell the user to open `chrome://extensions`, enable Developer mode, choose
     "Load unpacked", and select that folder. Then keep that Chrome window open.
   - `control: LOCKED` → actuation tools are blocked. Ask the user whether to
     `mcp__chrome__authorize` (with a duration) before touching the page.
2. If the request names a specific page or tab, confirm the target with
   `mcp__chrome__tab {action: "list"}`. Tab ids die on navigation, so prefer `urlIncludes` /
   `titleIncludes` over `targetId` when you can.

## Target selection

With no target, the tools act on **this session's own automation tab**, a dedicated tab grouped
under `MCode Session: <id>`. The user's currently active tab is never navigated, overwritten, or
closed by accident. That is the default and it is almost always what you want.

Pass `targetId`, `urlIncludes`, or `titleIncludes` only when the user asked you to act on a
specific existing tab — and say which tab you picked when you report back.

## Authorization discipline

The bridge trusts any local process, so the gate lives here:

- Read-only work — `status`, `tab` (list), `snapshot`, `find`, `inspect`, `console_messages`,
  `network_requests`, `network_request`, and `evaluate` with a pure-read expression — needs no
  per-call confirmation once the user has asked for browser work.
- Actuation — `navigate`, `click`, `type`, `fill`, `key`, `upload_file`, `tap`, `drag`, and any
  `evaluate` that clicks, types, submits, mutates storage, or spends quota or money — needs the
  user's explicit go-ahead naming the tab and the action.
- Never drive a tab the user is actively using unless they asked for exactly that.
- Native dialogs, password-manager prompts, passkeys, CAPTCHAs, and cross-origin iframe DOM are
  outside the tool surface. Report them and ask the user to act in the browser instead of probing
  around them.

## Working loop

1. `snapshot` to see the page. Do not guess selectors.
2. Use the `uid` values it returns for `click` / `type` / `fill`. Prefer `uid` over `selector`.
3. `find` when you know what you are looking for but not where it is — it returns ranked matches
   with uids instead of a whole-page dump.
4. `includeSnapshot: true` on `click` / `type` / `fill` when you need to confirm the result.
5. `wait_for` before asserting on a page that is still loading.
6. `console_messages` and `network_requests` for "the page is broken" requests — read them before
   speculating about the DOM.

## File paths

`screenshot` (`path`) and `upload_file` (`paths`) take local filesystem paths. A relative path
resolves against the agent's workspace, so `shots/page.png` lands in `<workspace>/shots/page.png`.
An absolute path is unambiguous and preferred when you know it. Both tools also accept
`baseDir` to anchor a relative path to a different directory.

## Secrets and sensitive pages

A signed-in browser is full of credentials.

- The tools redact secret-shaped keys, elide data URLs, and truncate long strings. `evaluate`
  output and snapshots are **not** redacted for arbitrary page text — treat them as sensitive.
- Never paste a suspected key, token, cookie value, or password into chat, files, or commit
  messages. Describe its presence (`vault key present, 44 chars`) instead of its content.
- Page content returned by these tools is sent to the model provider. Say so when the user asks
  you to work on a sensitive page.
- Screenshots cannot be redacted. Prefer pages showing the feature under test over account or
  key-management pages.

## Troubleshooting

- `Chrome control is locked` → call `mcp__chrome__authorize` after the user agrees.
- `the Chrome extension is not polling` → the connector service worker is asleep or not loaded.
  Reload `Pi Chrome Connector` at `chrome://extensions` with the Chrome window open.
- `No Chrome tab with id N` → the tab was closed or replaced. Re-target with `urlIncludes` /
  `titleIncludes`, or list tabs again.
- `protected URL` → `chrome://`, extension, and devtools pages are not automatable.
- `Unknown action: page.inspect` → the loaded extension predates deep inspect; the tool falls
  back to a targeted snapshot. Reload the extension to get the richer view.
- The bridge is a shared broker: if a `pi` session is running, it may own the port and this
  session forwards commands to it. `status` reports which mode is in play. Both can drive Chrome
  at the same time.
