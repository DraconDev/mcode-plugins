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

Read from pi's auth store (`~/.pi/agent/auth.json`, key `agnes`), so pi and mcode share one
login. `AGNES_API_KEY` and `AGNES_CN_API_KEY` override it.

## Retry

15 attempts, each a little later than the last, over roughly two to three minutes. 429, 5xx,
timeouts and dropped connections are retried; a server's `Retry-After` is honoured. 4xx responses
are not retried — a bad request will not fix itself.

## Relationship to pi

The media core is ported from [`pi-agnes-tools`](https://github.com/DraconDev/pi-agnes-tools)
(MIT), so the same API, models and quirks apply in both agents. pi keeps its own text-model
catalog; this plugin is media only.

## Test

```bash
node scripts/smoke-test.mjs            # status only, no credits spent
node scripts/smoke-test.mjs --generate # also generate one real image
```

## Licence

AGPL-3.0-or-later, matching this repository. The ported media core is from
`DraconDev/pi-agnes-tools` (MIT).
