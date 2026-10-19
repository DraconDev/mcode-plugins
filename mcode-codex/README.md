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

The OAuth credential lives in pi's auth store (`~/.pi/agent/auth.json`, key `openai-codex`), so the
same ChatGPT subscription works in pi and in mcode without a second sign-in. An expired token is
refreshed **in memory only** — this plugin does not write back to pi's auth file, so it cannot
corrupt another tool's state. `CODEX_IMAGE_ACCESS_TOKEN` and `CODEX_IMAGE_ACCOUNT_ID` override it.

## Retry

15 attempts, each a little later than the last, over roughly two to three minutes. 429, 5xx,
timeouts and dropped connections are retried; a server's `Retry-After` is honoured. 4xx responses
and Cloudflare challenges are not retried — they will not change.

The subscription has its own quota, separate from the API credits the `matrix` connector uses, so
a rate limit here does not block the other.

## Relationship to pi

Ported from `pi-codex-image-gen` (npm). The request shape, headers and streaming protocol match
the pi extension's, so the same account, quota and behaviour apply in both agents.

## Test

```bash
# status only, no credits spent
node -e '
import("node:child_process").then(async ({ spawn }) => {
  const c = spawn(process.execPath, ["./server/main.mjs"], { stdio: ["pipe","pipe","inherit"] });
  c.stdout.on("data", (d) => process.stdout.write(d));
  c.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:1, method:"initialize",
    params:{ protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{name:"t",version:"1"} } }) + "\n");
  setTimeout(() => { c.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:2, method:"tools/call",
    params:{ name:"status", arguments:{} } }) + "\n"); }, 300);
  setTimeout(() => { c.kill(); process.exit(0); }, 2500);
});'
```

## Licence

AGPL-3.0-or-later, matching this repository. The ported protocol handling is from
`pi-codex-image-gen` (MIT).
