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
 * True when `target` is `base` itself or lies underneath it.
 *
 * The comparison is lexical on already-resolved paths: `relative()` yields a
 * path that starts with `..` when the target escapes the base, and an
 * absolute path when the two live on different roots.
 */
function isInside(base, target) {
  const rel = relative(base, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Resolve the directory a relative path is anchored to.
 *
 * `baseDir` is an override for *where inside the workspace* a relative path
 * lands, not a way to redirect a read or a write to an arbitrary directory,
 * so it has to stay under the workspace.
 *
 * @param {string|undefined} baseDir
 * @param {string} workspaceCwd
 * @returns {string} an absolute path
 */
export function resolveBaseDir(baseDir, workspaceCwd) {
  const workspace = resolve(workspaceCwd);
  if (baseDir === undefined || baseDir === null || baseDir === '') return workspace;
  const base = isAbsolute(baseDir) ? baseDir : resolve(workspace, baseDir);
  if (!isInside(workspace, base)) {
    throw new Error(
      `baseDir must stay inside the workspace (${workspace}). Refused: ${baseDir}`,
    );
  }
  return base;
}

/**
 * Resolve a caller-supplied path against the workspace.
 *
 * The rule is the same for a file that is written (`savePath`) and a file
 * that is read (`referenceImages`): a relative path is resolved against the
 * base and has to stay inside it, so `../../.ssh/authorized_keys` is refused
 * instead of escaping the workspace. An absolute path is taken at face
 * value, because that is a documented and deliberate feature — "an absolute
 * path is unambiguous and preferred".
 *
 * @param {object} options
 * @param {string} options.path
 * @param {string} [options.baseDir]
 * @param {string} options.workspaceCwd
 * @param {string} [options.label] - what the path is, for the error message
 * @returns {string} an absolute path
 */
export function resolveToolPath({ path, baseDir, workspaceCwd, label = 'path' }) {
  const base = resolveBaseDir(baseDir, workspaceCwd);
  if (isAbsolute(path)) return path;
  const target = resolve(base, path);
  if (!isInside(base, target)) {
    throw new Error(
      `${label} must stay inside the workspace (${base}). Refused: ${path}`,
    );
  }
  return target;
}

/**
 * Read local reference images and encode them for the request.
 *
 * The count limit is checked before anything is read, so a batch of fifty
 * large files never reaches the disk. The per-file size limit is checked on
 * the bytes we hold, before base64 inflates them by a third.
 *
 * @param {string[]} paths
 * @param {string} baseDir
 * @param {string} workspaceCwd
 * @returns {Promise<Array<{mimeType: string, data: string}>>}
 */
export async function loadReferenceImages(paths, baseDir, workspaceCwd) {
  if (paths.length > MAX_EDIT_IMAGES) {
    throw new Error(`Too many reference images (${paths.length}, limit ${MAX_EDIT_IMAGES}).`);
  }
  const images = [];
  for (const path of paths) {
    const target = resolveToolPath({
      path,
      baseDir,
      workspaceCwd,
      label: 'reference image',
    });
    const mimeType = MIME_BY_EXTENSION[extname(target).toLowerCase()];
    if (!mimeType) {
      throw new Error(`Unsupported reference image type: ${path}. Use PNG, JPEG or WebP.`);
    }
    const buffer = await readFile(target);
    if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(
        `Reference image is too large: ${path} is ${buffer.length} bytes ` +
          `(limit ${MAX_INPUT_IMAGE_BYTES} bytes).`,
      );
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
      lines.push(`- reference image size: up to ${MAX_INPUT_IMAGE_BYTES} bytes each`);
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
            'against the agent workspace and have to stay inside it; absolute paths ' +
            'are unambiguous and preferred.',
        },
        savePath: {
          type: 'string',
          description:
            'Where to write the image. A relative path resolves against the agent ' +
            'workspace and has to stay inside it, but an absolute path ' +
            '(e.g. /home/you/project/hero.png) is unambiguous and preferred.',
        },
        baseDir: {
          type: 'string',
          description:
            'Directory a relative path resolves against, inside the agent workspace. ' +
            'Defaults to the agent workspace; it may not point outside it.',
        },
        maxRetries: { type: 'number', description: 'Override the retry count (default 15).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    handler: async (args, { workspaceCwd, sessionKey }) => {
      try {
        const credential = await resolveCodexCredential();
        // The base directory is an override for where inside the workspace a
        // relative path lands, so it can never redirect a read or a write
        // somewhere else.
        const baseDir = resolveBaseDir(args.baseDir, workspaceCwd);
        // Resolved before the call, so a path that escapes the workspace is
        // refused without spending a generation.
        const target = args.savePath
          ? resolveToolPath({
              path: args.savePath,
              baseDir,
              workspaceCwd,
              label: 'savePath',
            })
          : null;
        const inputImages = await loadReferenceImages(
          args.referenceImages ?? [],
          baseDir,
          workspaceCwd,
        );
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

        if (target) {
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
