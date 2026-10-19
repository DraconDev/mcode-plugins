#!/usr/bin/env node
/**
 * Test the PostToolUse hook's decision logic.
 *
 * The PostToolUse hook is the primary path for tool failures: it fires the
 * moment a tool fails, with the tool response in the payload, and turns a
 * transient failure into an instruction to retry. The Stop hook is only the
 * backstop for a model that gave up instead.
 *
 *   node scripts/post-tool-hook-test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const HOOK = join(PLUGIN_ROOT, 'hooks', 'post-tool-retry.mjs');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

/** Feed the hook a PostToolUse payload and return what it decided. */
async function runHook(payload, { env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'post-tool-hook-test-'));
  const data = {
    hook_event_name: 'PostToolUse',
    session_id: 'mvs_test_session_0001',
    turn_id: 'turn_1',
    cwd: home,
    tool_name: 'bash',
    tool_input: { command: 'curl https://example.com' },
    tool_response: '',
    ...payload,
  };

  const child = spawn(process.execPath, [HOOK], {
    env: {
      ...process.env,
      HOME: home,
      PLUGIN_ROOT,
      PLUGIN_DATA: join(home, 'plugin-data'),
      MCODE_RETRY_DELAY_MS: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  child.stdin.end(JSON.stringify(data));
  const code = await new Promise((done) => child.on('close', done));

  let parsed = null;
  try {
    parsed = out.trim() ? JSON.parse(out.trim()) : null;
  } catch {
    // leave null
  }
  return { parsed, out, err, code };
}

// 1. A rate-limited tool call is retried.
{
  const { parsed } = await runHook({
    tool_response: 'HTTP 429 Too Many Requests: rate limit exceeded',
  });
  check(
    'a 429 tool failure is retried',
    parsed?.hookSpecificOutput?.additionalContext !== undefined &&
      /retry/i.test(parsed.hookSpecificOutput.additionalContext),
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

// 2. A 5xx tool failure is retried.
{
  const { parsed } = await runHook({
    tool_response: 'Command failed with exit code 1\nupstream returned 503 Service Unavailable',
  });
  check(
    'a 503 tool failure is retried',
    parsed?.hookSpecificOutput?.additionalContext !== undefined,
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

// 3. A timeout is retried.
{
  const { parsed } = await runHook({
    tool_response: 'Command failed with exit code 1\nError: request timed out after 60000ms',
  });
  check(
    'a timeout is retried',
    parsed?.hookSpecificOutput?.additionalContext !== undefined,
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

// 4. A fatal error is not retried — a missing file will still be missing.
{
  const { parsed } = await runHook({
    tool_response: 'Command failed with exit code 1\nENOENT: no such file or directory',
  });
  check('a fatal error is not retried', parsed === null, parsed ? JSON.stringify(parsed) : 'no output');
}

// 5. A successful tool call that merely mentions 429 is not retried.
{
  const { parsed } = await runHook({
    tool_response: 'Found 429 records matching the pattern\n429 lines in output',
  });
  check(
    'a successful call mentioning 429 is not retried',
    parsed === null,
    parsed ? JSON.stringify(parsed) : 'no output',
  );
}

// 6. An explicit is_error: false wins over the text.
{
  const { parsed } = await runHook({
    tool_response: 'HTTP 429 Too Many Requests',
    is_error: false,
  });
  check(
    'is_error false suppresses the retry',
    parsed === null,
    parsed ? JSON.stringify(parsed) : 'no output',
  );
}

// 7. A structured tool response is flattened before matching.
{
  const { parsed } = await runHook({
    tool_response: {
      details: { execution: { status: 'failed', exitCode: 1 } },
      content: [{ type: 'text', text: '429 Too Many Requests' }],
    },
  });
  check(
    'a structured response is matched',
    parsed?.hookSpecificOutput?.additionalContext !== undefined,
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

// 8. The retry instruction tells the model to repeat the same operation.
{
  const { parsed } = await runHook({
    tool_name: 'generate_image',
    tool_response: 'HTTP 429 rate limit exceeded',
  });
  const context = parsed?.hookSpecificOutput?.additionalContext ?? '';
  check(
    'the instruction asks for the same operation again',
    /same operation|again/i.test(context) && /generate_image/.test(context),
    context.slice(0, 80),
  );
}

// 9. The hook stays quiet when it is disabled.
{
  const { parsed, code } = await runHook(
    { tool_response: 'HTTP 429 Too Many Requests' },
    { env: { MCODE_RETRY_DISABLED: '1' } },
  );
  check('the hook is a no-op when disabled', parsed === null && code === 0, `code=${code}`);
}

// 10. A malformed payload does not crash the hook.
{
  const { code, err } = await runHook({ tool_response: { weird: true } });
  check('an odd payload does not crash the hook', code === 0, `code=${code} err=${err.slice(0, 80)}`);
}

// 11. A structured failure marker in the tool result is authoritative.
{
  const { parsed } = await runHook({
    tool_response: JSON.stringify({
      details: { execution: { status: 'failed', exitCode: 1, message: 'Command exited with code 1' } },
      content: [{ type: 'text', text: 'HTTP 429 Too Many Requests' }],
    }),
  });
  check(
    'a structured failure marker is detected',
    parsed?.hookSpecificOutput?.additionalContext !== undefined,
    parsed ? 'matched' : 'no output',
  );
}

// 12. A tool result that reports success is never retried, even with a 429 in it.
{
  const { parsed } = await runHook({
    tool_response: JSON.stringify({
      status: 'succeeded',
      content: [{ type: 'text', text: 'HTTP 429 Too Many Requests' }],
    }),
  });
  check(
    'an explicit success wins over the text',
    parsed === null,
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

// 13. A file whose contents mention a 429 is not a failure.
{
  const { parsed } = await runHook({
    tool_name: 'read',
    tool_response: {
      content: [{ type: 'text', text: 'echo "HTTP 429 Too Many Requests"\nexit 7\n' }],
      numLines: 2,
      startLine: 1,
      totalLines: 2,
    },
  });
  check(
    'a read of a 429-mentioning file is not a failure',
    parsed === null,
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
