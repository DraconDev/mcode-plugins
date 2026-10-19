#!/usr/bin/env node
/**
 * Smoke-test the Codex MCP server, and optionally make a real generation.
 *
 *   node scripts/smoke-test.mjs            # status only, no credits spent
 *   node scripts/smoke-test.mjs --generate # also generate one real image
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const serverPath = join(resolve(HERE, '..'), 'server', 'main.mjs');
const generate = process.argv.includes('--generate');

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

let nextId = 1;
const request = (method, params) =>
  new Promise((resolvePromise) => {
    const id = nextId++;
    pending.set(id, resolvePromise);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

const call = async (name, args = {}) => {
  const response = await request('tools/call', { name, arguments: args });
  const blocks = response.result?.content ?? [];
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const images = blocks.filter((block) => block.type === 'image');
  console.log(`\n===== ${name} =====\n${text}`);
  for (const image of images) {
    console.log(
      `[image ${image.mimeType}, ${Math.round((image.data.length * 0.75) / 1024)} KB decoded]`,
    );
  }
  if (response.result?.isError) {
    console.log('!! tool reported an error');
    process.exitCode = 1;
  }
  return { response, images };
};

await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' },
});
child.stdin.write(
  `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
);

const list = await request('tools/list', {});
console.log(`tools/list -> ${list.result.tools.map((t) => t.name).join(', ')}`);

await call('status');

if (generate) {
  const started = Date.now();
  const { images } = await call('generate_image', {
    prompt: 'A single smooth river stone on a pale sand background, soft studio light, minimal',
  });
  console.log(`\nelapsed: ${Math.round((Date.now() - started) / 1000)}s`);
  if (images.length === 0) {
    console.log('!! no image returned');
    process.exit(1);
  }
}

child.stdin.end();
child.kill();
process.exit(process.exitCode ?? 0);
