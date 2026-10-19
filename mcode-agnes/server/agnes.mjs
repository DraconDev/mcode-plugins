/**
 * Agnes AI client.
 *
 * Ported from the media core of `pi-agnes-tools` (DraconDev/pi-agnes-tools,
 * MIT) so the same API is reachable from MiniMax Code. The API is
 * OpenAI-compatible: `POST /v1/images/generations` for images and
 * `POST /v1/videos` plus a poll endpoint for video.
 *
 * Two endpoints exist:
 *   - agnes     https://apihub.agnes-ai.com/v1  (international)
 *   - agnes-cn  https://api.agnes-ai.cn/v1      (China)
 */

import { fetchWithRetry, HttpError } from './retry.mjs';

export const ENDPOINTS = {
  agnes: {
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKeyEnv: 'AGNES_API_KEY',
    label: 'Agnes (international)',
  },
  'agnes-cn': {
    baseUrl: 'https://api.agnes-ai.cn/v1',
    apiKeyEnv: 'AGNES_CN_API_KEY',
    label: 'Agnes (China)',
  },
};

export const IMAGE_MODELS = [
  'agnes-image-2.0-flash',
  'agnes-image-2.1-flash',
  'agnes-image-2.5-flash',
];

export const VIDEO_MODELS = [
  'agnes-video-v2.0',
  'agnes-video-2.5',
  'agnes-video-2.5-flash',
];

export const DEFAULT_IMAGE_MODEL = 'agnes-image-2.5-flash';
export const DEFAULT_VIDEO_MODEL = 'agnes-video-2.5-flash';

function checkImageModel(model) {
  if (!IMAGE_MODELS.includes(model)) {
    throw new Error(
      `Unknown Agnes image model: ${model}. Known models: ${IMAGE_MODELS.join(', ')}`,
    );
  }
}

function checkVideoModel(model) {
  if (!VIDEO_MODELS.includes(model)) {
    throw new Error(
      `Unknown Agnes video model: ${model}. Known models: ${VIDEO_MODELS.join(', ')}`,
    );
  }
}

function apiRoot(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/**
 * Generate one image.
 *
 * @returns {Promise<{ dataUrl: string, mimeType: string, remoteUrl: string | null }>}
 */
export async function requestImage({ baseUrl, apiKey, model, prompt, size, ratio, images, responseFormat, retry }) {
  checkImageModel(model);

  const body = { model, prompt };
  if (responseFormat) body.response_format = responseFormat;
  if (images && images.length > 0) body.image = images;
  if (size) body.size = size;
  if (ratio) body.ratio = ratio;

  const response = await fetchWithRetry(
    `${baseUrl}/images/generations`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    retry,
  );

  const payload = await response.json().catch(() => null);
  const image = payload?.data?.[0];
  if (!image) throw new Error('Agnes image API returned no image data');

  const mime = image.mime_type || 'image/png';
  if (image.b64_json) {
    return {
      dataUrl: `data:${mime};base64,${image.b64_json}`,
      mimeType: mime,
      remoteUrl: image.url ?? null,
    };
  }
  if (image.url) {
    // The URL is short-lived; fetch it now so the caller gets bytes, not a link.
    const download = await fetchWithRetry(image.url, {}, retry);
    const buffer = Buffer.from(await download.arrayBuffer());
    return {
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      mimeType: mime,
      remoteUrl: image.url,
    };
  }
  throw new Error('Agnes image API returned no url or b64_json');
}

/** Poll a video task until it completes. */
export async function pollVideo({ baseUrl, apiKey, videoId, retry, signal, timeoutMs = 30 * 60_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Video generation aborted');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('Video generation aborted'));
          },
          { once: true },
        );
      }
    });

    const response = await fetchWithRetry(
      `${apiRoot(baseUrl)}/agnesapi?video_id=${encodeURIComponent(videoId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal },
      retry,
    );
    const payload = await response.json().catch(() => null);
    if (payload?.status === 'completed') return payload;
    if (payload?.status === 'failed') {
      throw new Error(payload?.error?.message || 'Agnes video generation failed');
    }
  }
  throw new Error('Agnes video generation timed out');
}

/**
 * Generate a video.
 *
 * The API accepts different fields per model: the flash and 2.5 routes reject
 * `num_frames` / `frame_rate` as request fields, and
 * `agnes-video-2.5-flash` requires a top-level `mode` for both text-to-video
 * and image-to-video. So those fields are only sent when the caller asks for
 * them, never as hard-coded defaults.
 */
export async function requestVideo({ baseUrl, apiKey, model, prompt, images, numFrames, frameRate, retry, signal }) {
  checkVideoModel(model);

  const body = { model, prompt };
  if (numFrames) body.num_frames = numFrames;
  if (frameRate) body.frame_rate = frameRate;

  const refs = images || [];
  if (model === 'agnes-video-2.5-flash') {
    if (refs.length === 0) body.mode = 't2v';
    if (refs.length === 1) body.mode = 'keyframe';
  }
  if (refs.length === 1) body.image = refs[0];
  if (refs.length > 1) body.extra_body = { image: refs, mode: 'keyframes' };

  const response = await fetchWithRetry(
    `${baseUrl}/videos`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    },
    retry,
  );

  const task = await response.json().catch(() => null);
  const videoId = task?.id ?? task?.video_id ?? task?.data?.id;
  if (!videoId) {
    throw new Error(
      task?.error?.message ?? 'Agnes video API returned no task id',
    );
  }

  const finished = await pollVideo({ baseUrl, apiKey, videoId, retry, signal });
  const url = finished?.url ?? finished?.video_url ?? finished?.data?.url;
  if (!url) throw new Error('Agnes video task completed without a URL');
  return { videoId, url, payload: finished };
}

export { HttpError };
