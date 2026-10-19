/**
 * The Agnes tool surface exposed over MCP.
 *
 * The MCP server is named `agnes`, so the model sees `mcp__agnes__generate_image`
 * and friends.
 *
 * Images come back as inline image content blocks, so the model can actually
 * look at what it generated. A file is written to disk as well when a path is
 * given, which is what you want for assets that end up in a repository.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  ENDPOINTS,
  IMAGE_MODELS,
  VIDEO_MODELS,
  requestImage,
  requestVideo,
} from './agnes.mjs';
import { resolveApiKey } from './auth.mjs';

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

function toolError(error) {
  return {
    content: [{ type: 'text', text: `ERROR: ${error?.message ?? String(error)}` }],
    isError: true,
  };
}

/** Build the retry options, allowing the caller to loosen or tighten them. */
function retryOptions(args) {
  const options = {};
  if (typeof args.maxRetries === 'number') options.maxRetries = args.maxRetries;
  if (typeof args.baseDelayMs === 'number') options.baseDelayMs = args.baseDelayMs;
  if (typeof args.maxDelayMs === 'number') options.maxDelayMs = args.maxDelayMs;
  return options;
}

function resolveEndpoint(name) {
  const endpoint = ENDPOINTS[name];
  if (!endpoint) {
    throw new Error(
      `Unknown Agnes endpoint: ${name}. Known endpoints: ${Object.keys(ENDPOINTS).join(', ')}`,
    );
  }
  return endpoint;
}

function credentialsFor(name) {
  const endpoint = resolveEndpoint(name);
  const { key, source } = resolveApiKey(name, endpoint.apiKeyEnv);
  if (!key) {
    throw new Error(
      `No Agnes API key found for ${endpoint.label}. Set ${endpoint.apiKeyEnv}, or sign in ` +
        'to the Agnes provider in pi so the key lands in pi\'s auth store ' +
        "(~/.pi/agent/auth.json), which this plugin reads.",
    );
  }
  return { endpoint, key, source };
}

/**
 * The tool definitions. Handlers take `(args, ctx)` so the same array can be
 * reused for the runtime and for the generated plugin manifest — the declared
 * tool list can then never drift from the running server.
 */
const TOOL_DEFS = [
  {
    name: 'status',
    description:
      'Check the Agnes plugin: which endpoints are configured, where the API key came from, the available image and video models, and the retry policy. Start here if a generation call fails.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, { workspaceCwd }) => {
      const lines = ['# Agnes'];
      for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
        const { key, source } = resolveApiKey(name, endpoint.apiKeyEnv);
        lines.push(
          `- ${endpoint.label} (${name}): ${key ? `credential found via ${source}` : 'NO CREDENTIAL'}`,
        );
      }
      lines.push(`- image models: ${IMAGE_MODELS.join(', ')} (default ${DEFAULT_IMAGE_MODEL})`);
      lines.push(`- video models: ${VIDEO_MODELS.join(', ')} (default ${DEFAULT_VIDEO_MODEL})`);
      lines.push(
        '- retry: 15 attempts, exponential backoff from 1.5s, each a little later; ' +
          '429/5xx/timeouts are retried, 4xx is not',
      );
      lines.push(`- workspace: ${workspaceCwd}`);
      lines.push(
        `- workspace env: ${Object.keys(process.env)
          .filter((key) => /WORKSPACE|CWD|PROJECT|MAVIS|MINIMAX/i.test(key))
          .join(', ') || '(none)'}`,
      );
      return text(lines.join('\n'));
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an image with Agnes AI. Returns the image inline so you can see it, and can also save it to disk. Rate limits and transient server errors are retried automatically, so a call that hits a quota usually still succeeds.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image should show.' },
        model: {
          type: 'string',
          enum: IMAGE_MODELS,
          description: 'Image model to use.',
          default: DEFAULT_IMAGE_MODEL,
        },
        endpoint: {
          type: 'string',
          enum: Object.keys(ENDPOINTS),
          description: 'Which Agnes region to call.',
          default: 'agnes',
        },
        size: { type: 'string', description: 'Output size, e.g. "1024x1024".' },
        ratio: { type: 'string', description: 'Aspect ratio, e.g. "16:9".' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reference image URLs for image-to-image.',
        },
        savePath: {
          type: 'string',
          description:
            'Where to write the image. A relative path resolves against the agent ' +
            'workspace, but an absolute path (e.g. /home/you/project/hero.png) is ' +
            'unambiguous and preferred.',
        },
        baseDir: {
          type: 'string',
          description: 'Directory a relative savePath resolves against. Defaults to the agent workspace.',
        },
        maxRetries: { type: 'number', description: 'Override the retry count (default 15).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    handler: async (args, { workspaceCwd }) => {
      try {
        const { endpoint, key } = credentialsFor(args.endpoint ?? 'agnes');
        const model = args.model ?? DEFAULT_IMAGE_MODEL;

        const image = await requestImage({
          baseUrl: endpoint.baseUrl,
          apiKey: key,
          model,
          prompt: args.prompt,
          size: args.size,
          ratio: args.ratio,
          images: args.images,
          retry: retryOptions(args),
        });

        const blocks = [];
        const base64 = image.dataUrl.replace(/^data:[^;]+;base64,/, '');
        blocks.push({ type: 'image', data: base64, mimeType: image.mimeType });

        if (args.savePath) {
          const target = resolve(args.baseDir ?? workspaceCwd, args.savePath);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(base64, 'base64'));
          blocks.push({ type: 'text', text: `Saved to ${target}.` });
        }
        blocks.push({
          type: 'text',
          text: `Generated with ${model} via ${endpoint.label}.${image.remoteUrl ? ` Source: ${image.remoteUrl}` : ''}`,
        });
        return { content: blocks };
      } catch (error) {
        return toolError(error);
      }
    },
  },
  {
    name: 'generate_video',
    description:
      'Generate a video with Agnes AI. Text-to-video, single-image keyframe, or start/end keyframes. Generation is polled until the task completes; transient failures are retried automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the video should show.' },
        model: {
          type: 'string',
          enum: VIDEO_MODELS,
          description: 'Video model to use.',
          default: DEFAULT_VIDEO_MODEL,
        },
        endpoint: {
          type: 'string',
          enum: Object.keys(ENDPOINTS),
          description: 'Which Agnes region to call.',
          default: 'agnes',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reference image URLs: one for a keyframe, two for start/end keyframes.',
        },
        numFrames: { type: 'number', description: 'Frame count, if the model accepts it.' },
        frameRate: { type: 'number', description: 'Frame rate, if the model accepts it.' },
        savePath: {
          type: 'string',
          description:
            'Where to download the video. A relative path resolves against the agent ' +
            'workspace, but an absolute path (e.g. /home/you/project/clip.mp4) is ' +
            'unambiguous and preferred.',
        },
        baseDir: {
          type: 'string',
          description: 'Directory a relative savePath resolves against. Defaults to the agent workspace.',
        },
        maxRetries: { type: 'number', description: 'Override the retry count (default 15).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    handler: async (args, { workspaceCwd }) => {
      try {
        const { endpoint, key } = credentialsFor(args.endpoint ?? 'agnes');
        const model = args.model ?? DEFAULT_VIDEO_MODEL;

        const video = await requestVideo({
          baseUrl: endpoint.baseUrl,
          apiKey: key,
          model,
          prompt: args.prompt,
          images: args.images,
          numFrames: args.numFrames,
          frameRate: args.frameRate,
          retry: retryOptions(args),
        });

        const blocks = [];
        if (args.savePath) {
          const target = resolve(args.baseDir ?? workspaceCwd, args.savePath);
          await mkdir(dirname(target), { recursive: true });
          const response = await fetch(video.url);
          if (!response.ok) {
            throw new Error(`Video download failed: HTTP ${response.status}`);
          }
          await writeFile(target, Buffer.from(await response.arrayBuffer()));
          blocks.push({ type: 'text', text: `Saved to ${target}.` });
        }
        blocks.push({
          type: 'text',
          text: `Video ready (${model}, task ${video.videoId}).\nURL: ${video.url}`,
        });
        return { content: blocks };
      } catch (error) {
        return toolError(error);
      }
    },
  },
];

/** Tool schemas for the plugin manifest — same source as the implementation. */
export const TOOL_SCHEMAS = TOOL_DEFS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

/**
 * @param {object} options
 * @param {string} options.workspaceCwd
 */
export function createTools({ workspaceCwd }) {
  return TOOL_DEFS.map((tool) => ({
    ...tool,
    handler: (args) => tool.handler(args, { workspaceCwd }),
  }));
}
