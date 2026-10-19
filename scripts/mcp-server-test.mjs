#!/usr/bin/env node
/**
 * Test the MCP stdio transport.
 *
 * The transport reads newline-delimited JSON from stdin. A peer that sends
 * something that is not a JSON-RPC object — a bare `null`, a number, a string
 * — must not take the server down: the session would die with every later
 * tool call failing.
 *
 * These tests drive the real server binary over a real pipe, because the
 * failure mode is an unhandled rejection, which only shows up at the process
 * level.
 *
 *   node scripts/mcp-server-test.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

/**
 * Feed lines to a server and collect what it writes back.
 *
 * @param {string} script - path to the server entry point, relative to the repo
 * @param {string[]} lines - lines to write to stdin
 * @param {number} [timeoutMs] - how long to wait for the process to settle
 */
function drive(script, lines, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, script)], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let exited = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
    });

    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();

    setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
      resolvePromise({ stdout, stderr, exitCode, exited: true, wasKilled: !exited });
    }, timeoutMs);
  });
}

/** The JSON-RPC responses a run produced, parsed. */
function responses(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// 1. A `null` line must not kill the server, and the next request must still
//    be answered. Before the fix this exited with code 1.
{
  const result = await drive('mcode-agnes/server/main.mjs', [
    'null',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  ]);
  const replies = responses(result.stdout);
  check(
    'a null line does not kill the server',
    result.exitCode === 0,
    `exit=${result.exitCode} stderr=${result.stderr.split('\n')[0] ?? ''}`,
  );
  check(
    'the server still answers the next request',
    replies.some((reply) => reply.id === 1 && reply.result?.serverInfo?.name),
    `replies=${replies.length}`,
  );
  check(
    'the null line is reported rather than swallowed',
    result.stderr.includes('not an object'),
    result.stderr.split('\n')[0] ?? '',
  );
}

// 2. The other shapes that are valid JSON but not JSON-RPC objects.
for (const [label, line] of [
  ['a bare number', '42'],
  ['a bare string', '"hello"'],
  ['an array', '[1,2,3]'],
  ['true', 'true'],
]) {
  const result = await drive('mcode-agnes/server/main.mjs', [
    line,
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
  ]);
  const replies = responses(result.stdout);
  check(
    `${label} does not kill the server`,
    result.exitCode === 0,
    `exit=${result.exitCode}`,
  );
  check(`${label} is skipped, and the next request is answered`, replies.some((r) => r.id === 7));
}

// 3. Malformed JSON is still skipped, and the server survives it.
{
  const result = await drive('mcode-agnes/server/main.mjs', [
    '{not json at all',
    JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
  ]);
  const replies = responses(result.stdout);
  check('malformed JSON does not kill the server', result.exitCode === 0, `exit=${result.exitCode}`);
  check('the server still answers after malformed JSON', replies.some((r) => r.id === 9));
}

// 4. The same transport is used by every plugin, so all of them must survive.
for (const plugin of ['mcode-codex', 'mcode-chrome']) {
  const result = await drive(`${plugin}/server/main.mjs`, [
    'null',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  ]);
  const replies = responses(result.stdout);
  check(
    `${plugin} survives a null line`,
    result.exitCode === 0,
    `exit=${result.exitCode} stderr=${result.stderr.split('\n')[0] ?? ''}`,
  );
  check(`${plugin} still answers the next request`, replies.some((r) => r.id === 1));
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
