#!/usr/bin/env node
/**
 * Regression tests for the Codex path and image limits.
 *
 * A relative path has to stay inside the workspace, `baseDir` may only point
 * inside it, the reference-image count is checked before anything is read,
 * and a single reference image may not be bigger than the documented limit.
 * The network is stubbed, so no credits are spent.
 *
 *   node scripts/path-safety-test.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

const textOf = (result) =>
  (result?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

const root = mkdtempSync(join(tmpdir(), 'mcode-codex-path-test-'));
const workspace = join(root, 'project');
const outside = join(root, 'outside');
const fakeHome = join(root, 'home');
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });
mkdirSync(fakeHome, { recursive: true });

// The credential is faked, and the real pi auth store is kept out of reach:
// the plugin reads `~/.pi/agent/auth.json` when it starts.
process.env.HOME = fakeHome;
process.env.CODEX_IMAGE_ACCESS_TOKEN = 'test-access-token-not-real';
process.env.CODEX_IMAGE_ACCOUNT_ID = 'acct-test';

const { createTools, loadReferenceImages, resolveToolPath } = await import('../server/tools.mjs');
const { MAX_EDIT_IMAGES, MAX_INPUT_IMAGE_BYTES } = await import('../server/codex.mjs');

const IMAGE_BYTES = 'fake-codex-image-bytes';
const requests = [];
let respond = null;

/**
 * A stub for the Codex endpoint. The successful answer is the SSE stream the
 * real endpoint sends: one `image_generation_call` item.
 */
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  if (respond) return respond();
  const sse = `data: ${JSON.stringify({
    type: 'response.output_item.done',
    item: {
      type: 'image_generation_call',
      status: 'completed',
      result: Buffer.from(IMAGE_BYTES).toString('base64'),
    },
  })}\n\n`;
  return new Response(sse, { status: 200 });
};

try {
  const tools = createTools({ workspaceCwd: workspace, sessionKey: 'test-session' });
  const generateImage = tools.find((tool) => tool.name === 'generate_image');

  // 1. A relative path resolves under the workspace.
  {
    const target = resolveToolPath({ path: 'assets/hero.png', workspaceCwd: workspace });
    check(
      'a relative path resolves under the workspace',
      target === join(workspace, 'assets/hero.png'),
      target,
    );
  }

  // 2. A relative path that escapes the workspace is refused.
  {
    requests.length = 0;
    const result = await generateImage.handler({
      prompt: 'a stone',
      savePath: '../../.ssh/authorized_keys',
    });
    const text = textOf(result);
    check('an escaping savePath is refused', result.isError === true, text);
    check(
      'the refusal explains the workspace rule',
      /must stay inside the workspace/.test(text),
      text,
    );
    check(
      'the escaping savePath is refused before any request',
      requests.length === 0,
      `${requests.length} request(s)`,
    );
  }

  // 2b. A reference image outside the workspace is refused, and not read.
  {
    requests.length = 0;
    const secret = join(outside, 'secret.png');
    writeFileSync(secret, 'not-an-image');
    const result = await generateImage.handler({
      prompt: 'a stone',
      referenceImages: ['../outside/secret.png'],
    });
    const text = textOf(result);
    check('an escaping reference image is refused', result.isError === true, text);
    check(
      'the reference-image refusal explains the workspace rule',
      /must stay inside the workspace/.test(text),
      text,
    );
    check(
      'the escaping reference image is refused before any request',
      requests.length === 0,
      `${requests.length} request(s)`,
    );
  }

  // 3. A baseDir outside the workspace is refused.
  {
    requests.length = 0;
    const result = await generateImage.handler({
      prompt: 'a stone',
      savePath: 'hero.png',
      baseDir: '/etc',
    });
    const text = textOf(result);
    check('a baseDir outside the workspace is refused', result.isError === true, text);
    check(
      'the baseDir refusal names baseDir',
      /baseDir must stay inside the workspace/.test(text),
      text,
    );
    check(
      'the baseDir refusal happens before any request',
      requests.length === 0,
      `${requests.length} request(s)`,
    );
  }

  // 4. A relative savePath lands in the workspace.
  {
    requests.length = 0;
    const result = await generateImage.handler({
      prompt: 'a stone',
      savePath: 'assets/hero.png',
    });
    const written = join(workspace, 'assets/hero.png');
    check('a relative savePath lands in the workspace', existsSync(written), written);
    check(
      'the file holds the generated bytes',
      existsSync(written) && readFileSync(written, 'utf8') === IMAGE_BYTES,
    );
    check('the generation ran', requests.length === 1, `${requests.length} request(s)`);
    check('the tool did not report an error', result.isError !== true, textOf(result));
  }

  // 5. The reference-image count is checked before anything is read: the
  //    files below do not exist, so a read would fail with ENOENT instead.
  {
    requests.length = 0;
    const paths = Array.from({ length: MAX_EDIT_IMAGES + 1 }, (_, index) => `ref-${index}.png`);
    let message = '';
    try {
      await loadReferenceImages(paths, workspace, workspace);
    } catch (error) {
      message = error.message;
    }
    check(
      'too many reference images are refused before any read',
      /Too many reference images/.test(message),
      message,
    );
    check(
      'the count limit names the limit',
      message.includes(String(MAX_EDIT_IMAGES)),
      message,
    );
  }

  // 6. A reference image bigger than the limit is refused.
  {
    requests.length = 0;
    const big = join(workspace, 'big.png');
    writeFileSync(big, Buffer.alloc(MAX_INPUT_IMAGE_BYTES + 1, 1));
    let message = '';
    try {
      await loadReferenceImages(['big.png'], workspace, workspace);
    } catch (error) {
      message = error.message;
    }
    check('an oversized reference image is refused', /too large/.test(message), message);
    check('the refusal names the file', message.includes('big.png'), message);
    check(
      'the refusal names the size',
      message.includes(String(MAX_INPUT_IMAGE_BYTES + 1)),
      message,
    );
    rmSync(big, { force: true });
  }

  // 6b. A reference image under the limit is read and encoded.
  {
    requests.length = 0;
    const small = join(workspace, 'small.png');
    writeFileSync(small, 'small-image');
    const images = await loadReferenceImages(['small.png'], workspace, workspace);
    check('a small reference image is read', images.length === 1, JSON.stringify(images));
    check(
      'the reference image is base64 encoded',
      images[0]?.data === Buffer.from('small-image').toString('base64'),
      images[0]?.data,
    );
    check('the reference image has a mime type', images[0]?.mimeType === 'image/png');
  }

  // 7. A Cloudflare challenge is not retried.
  {
    requests.length = 0;
    respond = () =>
      new Response('{}', {
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
      });
    const result = await generateImage.handler({ prompt: 'a stone' });
    check('a Cloudflare challenge is reported', /Cloudflare/.test(textOf(result)), textOf(result));
    check(
      'a Cloudflare challenge is not retried',
      requests.length === 1,
      `${requests.length} request(s)`,
    );
    respond = null;
  }

  // 8. A 408 is still retried — the challenge flag must not silence the
  //    shared policy.
  {
    requests.length = 0;
    respond = () => new Response('', { status: 408 });
    const result = await generateImage.handler({
      prompt: 'a stone',
      maxRetries: 1,
      baseDelayMs: 1,
    });
    check('a 408 is retried', requests.length === 2, `${requests.length} request(s)`);
    check('the 408 is reported', /HTTP 408/.test(textOf(result)), textOf(result));
    respond = null;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
