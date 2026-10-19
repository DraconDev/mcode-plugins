#!/usr/bin/env node
/**
 * Regression tests for the Agnes path rules.
 *
 * A relative path has to stay inside the workspace, and `baseDir` may only
 * point inside it — otherwise a generation could write anywhere the process
 * can reach. The network is stubbed, so no credits are spent.
 *
 *   node scripts/path-safety-test.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTools, resolveToolPath } from '../server/tools.mjs';

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

const root = mkdtempSync(join(tmpdir(), 'mcode-agnes-path-test-'));
const workspace = join(root, 'project');
const outside = join(root, 'outside');
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });

// A credential is needed to get past the credential check, and the key is
// never read from — or printed to — the real environment.
process.env.AGNES_API_KEY = 'test-key-not-a-real-credential';

const IMAGE_BYTES = 'fake-agnes-image-bytes';
const requests = [];

/**
 * A stub for the Agnes API. Nothing leaves the process: the image endpoint
 * answers with a base64 payload, the video endpoint with a task that is
 * already finished.
 */
globalThis.fetch = async (url, init) => {
  const target = String(url);
  requests.push({ url: target, init });
  if (target.endsWith('/videos')) {
    return new Response(JSON.stringify({ id: 'task-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (target.includes('video_id=')) {
    return new Response(
      JSON.stringify({ status: 'completed', url: 'https://example.invalid/clip.mp4' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({
      data: [{ b64_json: Buffer.from(IMAGE_BYTES).toString('base64'), mime_type: 'image/png' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

try {
  const tools = createTools({ workspaceCwd: workspace });
  const generateImage = tools.find((tool) => tool.name === 'generate_image');
  const generateVideo = tools.find((tool) => tool.name === 'generate_video');

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

  // 2b. An escaping savePath does not touch a file it could reach.
  {
    requests.length = 0;
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'untouched');
    const result = await generateImage.handler({
      prompt: 'a stone',
      savePath: '../outside/secret.txt',
    });
    check('a savePath next to the workspace is refused', result.isError === true, textOf(result));
    check(
      'the file outside the workspace is untouched',
      readFileSync(secret, 'utf8') === 'untouched',
    );
    check(
      'the refusal happens before any request',
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

  // 5. A relative baseDir stays under the workspace.
  {
    requests.length = 0;
    const result = await generateImage.handler({
      prompt: 'a stone',
      savePath: 'other.png',
      baseDir: 'assets',
    });
    const written = join(workspace, 'assets', 'other.png');
    check('a relative baseDir resolves inside the workspace', existsSync(written), written);
    check('the tool did not report an error', result.isError !== true, textOf(result));
  }

  // 6. An absolute savePath is still honoured — it is a documented feature.
  {
    requests.length = 0;
    const absolute = join(outside, 'absolute-hero.png');
    const result = await generateImage.handler({ prompt: 'a stone', savePath: absolute });
    check('an absolute savePath is still honoured', existsSync(absolute), absolute);
    check('the tool did not report an error', result.isError !== true, textOf(result));
  }

  // 7. The video tool applies the same rule, before a task is started.
  {
    requests.length = 0;
    const result = await generateVideo.handler({
      prompt: 'a stone',
      savePath: '../../evil.mp4',
    });
    const text = textOf(result);
    check('the video tool refuses an escaping savePath', result.isError === true, text);
    check(
      'the video refusal happens before any request',
      requests.length === 0,
      `${requests.length} request(s)`,
    );
  }

  // 8. A two-keyframe video request carries the top-level mode its own
  //    contract asks for.
  {
    requests.length = 0;
    const result = await generateVideo.handler({
      prompt: 'a stone',
      images: ['https://example.invalid/first.png', 'https://example.invalid/second.png'],
    });
    const call = requests.find((entry) => entry.url.endsWith('/videos'));
    const body = call ? JSON.parse(call.init.body) : {};
    check(
      'a two-keyframe request sets a top-level mode',
      body.mode === 'keyframes',
      JSON.stringify(body),
    );
    check(
      'the two-keyframe request keeps the reference list',
      Array.isArray(body.extra_body?.image) && body.extra_body.image.length === 2,
      JSON.stringify(body.extra_body),
    );
    check('the video tool did not report an error', result.isError !== true, textOf(result));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
