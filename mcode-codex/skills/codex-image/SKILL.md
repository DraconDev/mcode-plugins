---
name: codex-image
description: >-
  Generate and edit images with the ChatGPT subscription (Codex) from MiniMax Code. Use when the
  user asks to create, generate, or render an image, illustration, icon, portrait, sprite, or
  transparent cutout; wants an existing picture edited or restyled; or needs a batch of images in
  one locked style. The plugin retries rate limits and transient failures automatically, so a call
  that hits a quota usually still succeeds.
---

# Codex Images

ChatGPT subscription image generation, reachable as `mcp__codex__*`:

| Tool | Use it for |
| --- | --- |
| `mcp__codex__status` | Whether the subscription credential is present and valid, and the retry policy. |
| `mcp__codex__generate_image` | Text-to-image, and image-to-image from up to five reference files. |

The credential is the ChatGPT subscription OAuth token that pi already holds
(`openai-codex` in `~/.pi/agent/auth.json`), so the same subscription works in pi and in
mcode without a second sign-in. An expired token is refreshed in memory.

## Working with it

1. The image comes back **inline**, so look at it and say what you actually see.
2. Pass `savePath` for anything that should land in the repository. Use an **absolute** path
   (for example `/home/you/project/assets/hero.png`). The plugin server's working directory is
   the home directory, not the workspace, so a relative path would land in the wrong place.
   `baseDir` can supply a base for relative paths, but absolute is simpler.
3. `referenceImages` takes **local paths** (PNG, JPEG or WebP), not URLs. Up to five. Use
   absolute paths here too, for the same reason.
4. For a transparent background, say so in the prompt explicitly — "TRANSPARENT background, true
   alpha channel" — and check the result before shipping it.
5. For a batch, call the tool once per image with the same style guide in each prompt. A single
   call makes one image.

## Retry behaviour

- 15 attempts, each a little later than the last, spread over roughly two to three minutes
- 429, 5xx, timeouts and dropped connections are retried
- a `Retry-After` from the server is honoured
- 4xx responses (bad prompt, bad token, Cloudflare challenge) are **not** retried

If a call still fails after all attempts, read the message. A quota that says "you have used your
limit" will not clear by retrying in the same hour — switch provider or come back later.

## Notes

- Image generation is not deterministic. Retrying after a timeout can yield a different picture
  than the one that was in flight, so generate a batch by calling the tool repeatedly rather than
  by relying on one call to land.
- The ChatGPT subscription has its own quota, separate from the API credits the `matrix`
  connector uses. That separation is useful: hit one and the other still works.
- Never put credentials into a prompt. The plugin reads them from the auth store.
