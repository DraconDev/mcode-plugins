/**
 * ChatGPT subscription image generation.
 *
 * Ported from `pi-codex-image-gen` (npm) so the same ChatGPT subscription
 * that backs image generation in pi also works from MiniMax Code.
 *
 * The backend is the ChatGPT Codex Responses endpoint with the native
 * `image_generation` tool:
 *
 *   POST https://chatgpt.com/backend-api/codex/responses
 *
 * The response is an SSE stream; the image arrives in an
 * `image_generation_call` output item as base64.
 */

import { HttpError } from './retry.mjs';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const AUTH_CLAIM = 'https://api.openai.com/auth';
export const DEFAULT_MODEL = 'gpt-6-astra';
export const OPENAI_BETA_HEADER = 'responses=experimental';
export const OUTPUT_FORMATS = ['png', 'jpeg', 'webp'];
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_EDIT_IMAGES = 5;
export const MAX_PROMPT_CHARS = 32_000;

const INSTRUCTIONS =
  'You are generating bitmap image assets. For this request, call the image_generation tool ' +
  'exactly once. Do not answer with only text unless image generation is unavailable.';

/** Read the ChatGPT account id out of the access token. */
export function extractImageAccountId(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) throw new Error('Image OAuth token has no valid ChatGPT account ID.');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Image OAuth token has no valid ChatGPT account ID.');
  }
  const accountId = payload?.[AUTH_CLAIM]?.chatgpt_account_id;
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('Image OAuth token has no valid ChatGPT account ID.');
  }
  return accountId;
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.access_token !== 'string') {
    throw new Error(
      'Could not refresh the ChatGPT image credential. Sign in again for the image provider in pi.',
    );
  }
  return {
    access: payload.access_token,
    refresh: payload.refresh_token ?? refreshToken,
    expires: payload.expires_in ? Date.now() + payload.expires_in * 1000 : null,
    accountId: extractImageAccountId(payload.access_token),
  };
}

export function buildRequestBody({ prompt, model, outputFormat, sessionId, inputImages = [] }) {
  return {
    model,
    store: false,
    stream: true,
    prompt_cache_key: sessionId,
    instructions: INSTRUCTIONS,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...inputImages.map((image) => ({
            type: 'input_image',
            image_url: `data:${image.mimeType};base64,${image.data}`,
          })),
        ],
      },
    ],
    tools: [{ type: 'image_generation', output_format: outputFormat }],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    text: { verbosity: 'low' },
  };
}

function buildHeaders({ token, accountId }) {
  return {
    Authorization: `Bearer ${token}`,
    'chatgpt-account-id': accountId,
    originator: 'mcode',
    'User-Agent': 'mcode-codex',
    'OpenAI-Beta': OPENAI_BETA_HEADER,
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
}

/** Turn a non-2xx response into a useful, non-leaking message. */
async function httpFailure(response) {
  const body = await response.text().catch(() => '');
  let message = `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message ?? parsed?.message ?? message;
  } catch {
    if (body) message = `HTTP ${response.status}: ${body.slice(0, 300)}`;
  }
  // A Cloudflare challenge means the request was not authenticated as the
  // subscriber, and retrying will not change that.
  const challenged = response.headers.get('cf-mitigated') === 'challenge';
  return {
    message: challenged
      ? 'Codex connection was challenged by Cloudflare. This does not establish model or subscription availability.'
      : message,
    challenged,
  };
}

/**
 * Parse the SSE stream and pull out the generated image.
 *
 * Only the image is ever returned — the stream can contain text and internal
 * identifiers, none of which should reach the model.
 */
async function parseCodexSse(response) {
  const decoder = new TextDecoder();
  let buffer = '';
  let image = null;
  let revisedPrompt = null;

  const handleFrame = (frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') return;

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('Codex returned an invalid stream event.');
    }

    if (event.type === 'error' || event.type === 'response.failed') {
      const error = event.response?.error ?? event.error ?? event;
      throw new Error(error?.message ?? 'Codex image generation failed.');
    }
    if (event.type === 'response.incomplete') {
      throw new Error('Codex response was incomplete.');
    }
    if (event.type === 'response.output_item.done') {
      const item = event.item;
      if (item?.type !== 'image_generation_call') return;
      if (image) throw new Error('Codex returned more than one image.');
      if (item.status !== 'completed') throw new Error('Codex image generation did not complete.');
      if (typeof item.result !== 'string' || !item.result) {
        throw new Error('Codex image_generation_call did not contain image data.');
      }
      if (item.result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
        throw new Error('Codex image exceeded the 32 MiB size limit.');
      }
      image = { base64: item.result, revisedPrompt: item.revised_prompt ?? null };
      return;
    }
    if (event.type === 'response.output_text.delta' && !revisedPrompt) {
      if (typeof event.delta === 'string') revisedPrompt = event.delta;
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      handleFrame(frame);
    }
  }
  if (buffer.trim()) handleFrame(buffer);

  if (!image) throw new Error('Codex stream ended before an image was produced.');
  return { ...image, revisedPrompt };
}

/**
 * Generate one image.
 *
 * `fetchWithRetry` handles the retry policy; this function is the single
 * attempt.
 */
export async function requestImage({
  token,
  accountId,
  prompt,
  model = DEFAULT_MODEL,
  outputFormat = 'png',
  sessionId,
  inputImages = [],
  signal,
}) {
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt is too long (${prompt.length} characters, limit ${MAX_PROMPT_CHARS}).`);
  }
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    throw new Error(`Unknown output format: ${outputFormat}. Known: ${OUTPUT_FORMATS.join(', ')}`);
  }
  if (inputImages.length > MAX_EDIT_IMAGES) {
    throw new Error(`Too many reference images (${inputImages.length}, limit ${MAX_EDIT_IMAGES}).`);
  }

  const body = JSON.stringify(
    buildRequestBody({ prompt, model, outputFormat, sessionId, inputImages }),
  );

  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: buildHeaders({ token, accountId }),
    body,
    signal,
    redirect: 'error',
  });

  if (!response.ok) {
    const failure = await httpFailure(response);
    const error = new HttpError(response.status, failure.message, {
      headers: response.headers,
    });
    // Only the Cloudflare challenge is forced to be non-retryable. Every
    // other status is left to the shared policy, so a 408 is still retried.
    if (failure.challenged) error.retryable = false;
    throw error;
  }

  return parseCodexSse(response);
}
