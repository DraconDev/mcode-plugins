#!/usr/bin/env node
/**
 * Smoke-test the MCP server over stdio: initialize, list tools, call a few.
 *
 *   node scripts/smoke-test.mjs [toolName ...]
 *
 * Defaults to `status`, `tab` (list), and `snapshot`.
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(resolve(here, '..'), 'server', 'main.mjs');

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
function request(method, params) {
  const id = nextId++;
  return new Promise((resolvePromise) => {
    pending.set(id, resolvePromise);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' },
});
console.log('initialize →', JSON.stringify(init.result ?? init.error));
notify('notifications/initialized', {});

const list = await request('tools/list', {});
const tools = list.result?.tools ?? [];
console.log(`tools/list → ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

const requested = process.argv.slice(2);
const calls = requested.length ? requested : ['status', 'tab', 'snapshot'];
for (const name of calls) {
  const args = name === 'tab' ? { action: 'list' } : {};
  const result = await request('tools/call', { name, arguments: args });
  const text = (result.result?.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
  console.log(`\n===== tools/call ${name} =====\n${text}`);
  if (result.result?.isError) console.log('(tool reported an error)');
}

child.stdin.end();
child.kill();
process.exit(0);
