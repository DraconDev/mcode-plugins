#!/usr/bin/env node
/**
 * End-to-end actuation test against the live Chrome companion extension.
 *
 *   node scripts/e2e-test.mjs [url]
 *
 * Navigates the session's own automation tab (never the user's active tab),
 * then exercises snapshot, find, evaluate, console and screenshot.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(resolve(here, '..'), 'server', 'main.mjs');
const targetUrl = process.argv[2] ?? 'https://example.com';

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });

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
  console.log(`\n===== ${name} =====`);
  console.log(text.slice(0, 1400));
  for (const image of images) {
    console.log(`[image ${image.mimeType}, ${Math.round(image.data.length * 0.75 / 1024)} KB decoded]`);
  }
  if (response.result?.isError) console.log('!! tool reported an error');
};

await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'e2e', version: '1.0.0' },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

await call('status');
await call('navigate', { url: targetUrl });
await call('snapshot', { mode: 'interactive' });
await call('find', { query: 'More information' });
await call('evaluate', { expression: 'document.title' });
await call('console_messages');
await call('screenshot');
await call('tab', { action: 'list' });

child.stdin.end();
child.kill();
process.exit(0);
