# mcode-agnes

Agnes AI image and video generation for MiniMax Code.

The API is OpenAI-compatible: `POST /v1/images/generations` for images, `POST /v1/videos` plus a
poll endpoint for video. Two regions are available — `agnes` (international) and `agnes-cn`
(China).

## Tools

The MCP server is named `agnes`, so the tools are `mcp__agnes__*`:

| Tool | Purpose |
| --- | --- |
| `status` | Which endpoints and models are available, and where the credential came from. |
| `generate_image` | Text-to-image and image-to-image. Returns the image inline. |
| `generate_video` | Text-to-video, keyframe, and start/end keyframe video. |

## Credential

Set `AGNES_API_KEY` (or `AGNES_CN_API_KEY` for the other region) in the environment. That is all
this plugin needs — no other tool has to be installed.

If you already sign in to Agnes through [pi](https://github.com/tianrendong/pi), the key is picked
up automatically from pi's auth store (`~/.pi/agent/auth.json`, key `agnes`), so one login serves
both agents. That is a convenience, not a dependency: without pi, the environment variable alone
is enough. The environment variable wins when both are present.

## Retry

15 attempts, each a little later than the last, over roughly two to three minutes. 429, 5xx,
timeouts and dropped connections are retried; a server's `Retry-After` is honoured. 4xx responses
are not retried — a bad request will not fix itself.

## Relationship to pi

The media core is ported from [`pi-agnes-tools`](https://github.com/DraconDev/pi-agnes-tools)
(MIT), so the same API, models and quirks apply in both agents. pi keeps its own text-model
catalog; this plugin is media only.

## Paths

`savePath` takes a local path. A relative path resolves against the **agent workspace** — the
directory mcode was launched from — because MiniMax Code spawns plugin MCP servers with the home
directory as their working directory and passes no workspace path in the environment. An absolute
path is unambiguous and preferred; `baseDir` overrides the base directory for a relative path.

Paths are contained to the workspace. A relative path that would escape its base is refused, and
a `baseDir` that points outside the workspace is refused too — so a prompt that asks for
`../../.ssh/authorized_keys` gets an error instead of a file. The refusal happens before the
request is sent, so nothing is generated for a doomed call.

`MCODE_WORKSPACE` overrides the workspace directory that relative paths resolve against.

## Test

```bash
node scripts/smoke-test.mjs            # status only, no credits spent
node scripts/smoke-test.mjs --generate # also generate one real image
node scripts/build-manifest.mjs        # regenerate mcp/agnes.mcp.json from server/tools.mjs
```

## Licence

AGPL-3.0-or-later, matching this repository. The ported media core is from
`DraconDev/pi-agnes-tools` (MIT).
