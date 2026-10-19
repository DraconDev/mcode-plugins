/**
 * The Codex image tool surface exposed over MCP.
 *
 * The MCP server is named `codex`, so the model sees
 * `mcp__codex__generate_image`.
 *
 * Images come back as inline image content blocks so the model can look at
 * what it generated, and can also be written to disk.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  DEFAULT_MODEL,
  MAX_EDIT_IMAGES,
  MAX_INPUT_IMAGE_BYTES,
  OUTPUT_FORMATS,
  requestImage,
} from './codex.mjs';
import { resolveCodexCredential } from './auth.mjs';
import { withRetry } from './retry.mjs';

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

function toolError(error) {
  return {
    content: [{ type: 'text', text: `ERROR: ${error?.message ?? String(error)}` }],
    isError: true,
  };
}

const MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function retryOptions(args) {
  const options = {};
  if (typeof args.maxRetries === 'number') options.maxRetries = args.maxRetries;
  if (typeof args.baseDelayMs === 'number') options.baseDelayMs = args.baseDelayMs;
  if (typeof args.maxDelayMs === 'number') options.maxDelayMs = args.maxDelayMs;
  return options;
}

/**
 * Read local reference images and encode them for the request.
 *
 * @param {string[]} paths
 * @param {string} baseDir
 * @returns {Promise<Array<{mimeType: string, data: string}>>}
 */
async function loadReferenceImages(paths, baseDir) {
  const images = [];
  for (const path of paths) {
    const target = resolve(baseDir, path);
    const buffer = await readFile(target);
    const mimeType = MIME_BY_EXTENSION[extname(target).toLowerCase()];
    if (!mimeType) {
      throw new Error(`Unsupported reference image type: ${path}. Use PNG, JPEG or WebP.`);
    }
    images.push({ mimeType, data: buffer.toString('base64') });
  }
  return images;
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
      'Check the Codex image plugin: whether the ChatGPT subscription credential is present and valid, which models and output formats are available, and the retry policy. Start here if a generation call fails.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, { workspaceCwd }) => {
      const lines = ['# Codex images'];
      try {
        const credential = await resolveCodexCredential();
        lines.push(`- credential: found via ${credential.source}`);
        lines.push(`- account id: ${credential.accountId ?? '(unknown)'}`);
        lines.push(`- token: ${credential.refreshed ? 'refreshed just now' : 'valid'}`);
      } catch (error) {
        lines.push(`- credential: ${error?.message ?? error}`);
      }
      lines.push(`- model: ${DEFAULT_MODEL} (the backend selects the image model)`);
      lines.push(`- output formats: ${OUTPUT_FORMATS.join(', ')}`);
      lines.push(`- reference images per call: up to ${MAX_EDIT_IMAGES}`);
      lines.push(
        '- retry: 15 attempts, exponential backoff from 1.5s, each a little later; ' +
          '429/5xx/timeouts are retried, 4xx is not',
      );
      lines.push(`- workspace: ${workspaceCwd}`);
      return text(lines.join('\n'));
    },
  },
  {
    name: 'generate_image',
    description:
      'Generate an image with the ChatGPT subscription (Codex). Returns the image inline so you can see it, and can also save it to disk. Up to five reference images can be supplied to edit an existing picture. Rate limits and transient server errors are retried automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image should show.' },
        outputFormat: {
          type: 'string',
          enum: OUTPUT_FORMATS,
          description: 'Image format.',
          default: 'png',
        },
        model: {
          type: 'string',
          description: 'Model override. The backend normally selects the image model itself.',
        },
        referenceImages: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Up to five local PNG/JPEG/WebP paths to edit from. Relative paths resolve ' +
            'against the agent workspace; absolute paths are unambiguous and preferred.',
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
    handler: async (args, { workspaceCwd, sessionKey }) => {
      try {
        const credential = await resolveCodexCredential();
        const baseDir = args.baseDir ?? workspaceCwd;
        const inputImages = await loadReferenceImages(args.referenceImages ?? [], baseDir);
        const outputFormat = args.outputFormat ?? 'png';

        const image = await withRetry(
          () =>
            requestImage({
              token: credential.access,
              accountId: credential.accountId,
              prompt: args.prompt,
              model: args.model ?? DEFAULT_MODEL,
              outputFormat,
              sessionId: sessionKey,
              inputImages,
            }),
          retryOptions(args),
        );

        const mimeType = `image/${outputFormat === 'jpeg' ? 'jpeg' : outputFormat}`;
        const blocks = [{ type: 'image', data: image.base64, mimeType }];

        if (args.savePath) {
          const target = resolve(baseDir, args.savePath);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, Buffer.from(image.base64, 'base64'));
          blocks.push({ type: 'text', text: `Saved to ${target}.` });
        }
        blocks.push({
          type: 'text',
          text: `Generated via the ChatGPT subscription${inputImages.length ? ` from ${inputImages.length} reference image(s)` : ''}.${image.revisedPrompt ? `\nRevised prompt: ${image.revisedPrompt}` : ''}`,
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
 * @param {string} options.sessionKey
 */
export function createTools({ workspaceCwd, sessionKey }) {
  return TOOL_DEFS.map((tool) => ({
    ...tool,
    handler: (args) => tool.handler(args, { workspaceCwd, sessionKey }),
  }));
}
