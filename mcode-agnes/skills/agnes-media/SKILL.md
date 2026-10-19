---
name: agnes-media
description: >-
  Generate images and video with Agnes AI from MiniMax Code. Use when the user asks to create,
  generate, or render an image, illustration, icon, portrait, sprite, or video; wants a picture
  edited from reference images; or asks for a specific Agnes model. The plugin retries rate
  limits and transient failures automatically, so a call that hits a quota usually still succeeds.
---

# Agnes Media

Agnes AI image and video generation, reachable as `mcp__agnes__*`:

| Tool | Use it for |
| --- | --- |
| `mcp__agnes__status` | Which endpoints and models are available, and where the credential came from. |
| `mcp__agnes__generate_image` | Text-to-image and image-to-image. |
| `mcp__agnes__generate_video` | Text-to-video, keyframe, and start/end keyframe video. |

The credential is an Agnes API key, read from the environment: `AGNES_API_KEY`, or
`AGNES_CN_API_KEY` for the other region. If no environment variable is set, a key that was
already signed in through pi is used instead — that is a convenience, not a requirement.

## Working with it

1. `generate_image` returns the image **inline**, so you can look at it. Say what you see rather
   than describing the prompt back.
2. Pass `savePath` when the image is an asset that should land in the repository. A relative
   path resolves against the agent's workspace, so `assets/hero.png` lands in
   `<workspace>/assets/hero.png`. An absolute path is unambiguous and preferred when you know it.
   `baseDir` overrides the base directory for a relative path.
3. `size` and `ratio` are separate fields; set the one the request actually calls for.
4. For image-to-image, pass `images` as URLs, not local paths. The API fetches them itself.
5. For video: one reference image is a keyframe, two are start and end keyframes. The
   `agnes-video-2.5-flash` model requires the matching `mode` field, which the plugin sets for you.

## Retry behaviour

The plugin retries on its own, so you do **not** need to loop:

- 15 attempts, each a little later than the last, spread over roughly two to three minutes
- 429, 5xx, timeouts and dropped connections are retried
- a `Retry-After` from the server is honoured
- 4xx responses (bad request, bad key) are **not** retried — they will not fix themselves

If a call still fails after all attempts, the error message says why. Fix the cause rather than
retrying: a missing credential, an unknown model, or a prompt the endpoint rejects will fail
identically every time.

## Models

- Images: `agnes-image-2.5-flash` (default), `agnes-image-2.1-flash`, `agnes-image-2.0-flash`
- Video: `agnes-video-2.5-flash` (default), `agnes-video-2.5`, `agnes-video-v2.0`
- Regions: `agnes` (international, default), `agnes-cn` (China)

## Notes

- Image generation is not deterministic. Two calls with the same prompt give different images, so
  a retry after a *timeout* may produce a different picture than the one that was in flight.
  Generate a batch by calling the tool several times, not by retrying one call.
- Do not put credentials into prompts. The plugin reads them from the auth store; there is no
  reason to echo a key into a prompt or a file.
