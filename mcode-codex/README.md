# mcode-codex

ChatGPT subscription (Codex) image generation and editing for MiniMax Code.

The backend is the ChatGPT Codex Responses endpoint with the native `image_generation` tool:

```
POST https://chatgpt.com/backend-api/codex/responses
```

The response is an SSE stream; the image arrives in an `image_generation_call` output item as
base64.

## Tools

The MCP server is named `codex`, so the tools are `mcp__codex__*`:

| Tool | Purpose |
| --- | --- |
| `status` | Whether the subscription credential is present and valid, and the retry policy. |
| `generate_image` | Text-to-image, and image-to-image from up to five reference files. |

## Credential

Set `CODEX_IMAGE_ACCESS_TOKEN` in the environment — the ChatGPT subscription's image OAuth access
token. Add `CODEX_IMAGE_ACCOUNT_ID` if you want to name the account explicitly; otherwise it is
read from the token itself. That is all this plugin needs — no other tool has to be installed.

If you already sign in to the Codex image provider through
[pi](https://github.com/tianrendong/pi), the credential is picked up automatically from pi's auth
store (`~/.pi/agent/auth.json`, key `openai-codex`), so one login serves both agents. That is a
convenience, not a dependency: without pi, the environment variable alone is enough. The
environment variable wins when both are present.

A token from pi's store is refreshed when it expires, **in memory only** — this plugin does not
write back to pi's auth file, so it cannot corrupt another tool's state. A token you supply
yourself is never refreshed: supply a fresh one when it expires.

## Retry

15 attempts, each a little later than the last, over roughly two to three minutes. 429, 5xx,
timeouts and dropped connections are retried; a server's `Retry-After` is honoured. 4xx responses
and Cloudflare challenges are not retried — they will not change.

The subscription has its own quota, separate from the API credits the `matrix` connector uses, so
a rate limit here does not block the other.

## Where the code came from

Ported from `pi-codex-image-gen` (npm). The request shape, headers and streaming protocol match
the pi extension's, so the same account, quota and behaviour apply in both agents.

That is a note about where the code came from, not a runtime dependency — this plugin runs on its
own, with node and nothing else.

## Paths

`savePath` and `referenceImages` take local paths. A relative path resolves against the **agent
workspace** — the directory mcode was launched from — because MiniMax Code spawns plugin MCP
servers with the home directory as their working directory and passes no workspace path in the
environment. An absolute path is unambiguous and preferred; `baseDir` overrides the base directory
for a relative path.

Paths are contained to the workspace. A relative path that would escape its base is refused, and
a `baseDir` that points outside the workspace is refused too — so a prompt that asks to read
`../secret.png` gets an error instead of a file. The refusal happens before the request is sent,
so nothing is generated for a doomed call.

Reference images are capped at five per call and 20 MB each. Both limits are checked before the
file is read, and before any request is sent.

`MCODE_WORKSPACE` overrides the workspace directory that relative paths resolve against.

## Test

```bash
node scripts/smoke-test.mjs            # status only, no credits spent
node scripts/smoke-test.mjs --generate # also generate one real image
node scripts/build-manifest.mjs        # regenerate mcp/codex.mcp.json from server/tools.mjs
```

## Licence

AGPL-3.0-or-later, matching this repository. The ported protocol handling is from
`pi-codex-image-gen` (MIT).
