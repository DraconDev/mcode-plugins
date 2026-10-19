#!/usr/bin/env node
/**
 * Test the Stop hook's decision logic against synthetic session transcripts.
 *
 * The hook reads the real session layout under $HOME/.minimax/v2/sessions, so
 * the test builds a throwaway HOME with a fake session and feeds the hook the
 * same payload shape mcode sends.
 *
 *   node scripts/hook-test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const HOOK = join(PLUGIN_ROOT, 'hooks', 'stop-retry.mjs');

const SESSION_ID = 'mvs_test_session_0001';
const B64 = Buffer.from(SESSION_ID, 'utf8').toString('base64');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

/** Build a fake session with the given message list and run the hook. */
async function runHook(messages, { payload = {}, env = {}, home = null } = {}) {
  const sessionHome = home ?? mkdtempSync(join(tmpdir(), 'retry-hook-test-'));
  const sessionDir = join(
    sessionHome,
    '.minimax',
    'v2',
    'sessions',
    '2026',
    '10',
    '19',
    `12-00-00-000-session_${B64}`,
  );
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'messages.jsonl'),
    messages.map((message) => JSON.stringify({ message })).join('\n'),
  );

  const data = {
    hook_event_name: 'Stop',
    session_id: SESSION_ID,
    turn_id: 'turn_1',
    transcript_path: null,
    cwd: sessionHome,
    stop_hook_active: false,
    last_assistant_message: 'done',
    ...payload,
  };

  const child = spawn(process.execPath, [HOOK], {
    env: {
      ...process.env,
      HOME: sessionHome,
      PLUGIN_ROOT,
      PLUGIN_DATA: join(sessionHome, 'plugin-data'),
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
  return { parsed, out, err, code, home: sessionHome };
}

const user = { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: Date.now() };
const assistantOk = {
  role: 'assistant',
  content: [{ type: 'text', text: 'all good' }],
  stopReason: 'stop',
  timestamp: Date.now(),
};
const assistantError = {
  role: 'assistant',
  content: [],
  stopReason: 'error',
  errorMessage: 'provider returned 503',
  timestamp: Date.now(),
};
const assistantAborted = {
  role: 'assistant',
  content: [],
  stopReason: 'aborted',
  timestamp: Date.now(),
};
const assistantToolUse = {
  role: 'assistant',
  content: [{ type: 'toolUse', name: 'bash', input: { command: 'curl https://example.com' } }],
  stopReason: 'toolUse',
  timestamp: Date.now(),
};
const toolRateLimited = {
  role: 'toolResult',
  toolName: 'generate_image',
  isError: true,
  content: [{ type: 'text', text: 'HTTP 429 rate limit exceeded, please retry' }],
  timestamp: Date.now(),
};
const toolFatal = {
  role: 'toolResult',
  toolName: 'read',
  isError: true,
  content: [{ type: 'text', text: 'ENOENT: no such file or directory' }],
  timestamp: Date.now(),
};

// 1. A clean turn must not be retried.
{
  const { parsed } = await runHook([user, assistantOk]);
  check('clean turn is not retried', parsed === null, parsed ? JSON.stringify(parsed) : 'no output');
}

// 2. A turn that ended in an error must be retried.
{
  const { parsed } = await runHook([user, assistantError]);
  check(
    'error stopReason is retried',
    parsed?.decision === 'block' && /error/.test(parsed?.reason ?? ''),
    parsed ? `decision=${parsed.decision}` : 'no output',
  );
}

// 3. A rate-limited tool call must be retried.
{
  const { parsed } = await runHook([user, assistantOk, toolRateLimited]);
  check(
    'rate-limited tool call is retried',
    parsed?.decision === 'block' && /rate limit/i.test(parsed?.reason ?? ''),
    parsed ? 'blocked' : 'no output',
  );
}

// 4. A non-transient tool failure must not be retried.
{
  const { parsed } = await runHook([user, assistantOk, toolFatal]);
  check('fatal tool error is not retried', parsed === null, parsed ? 'blocked (wrong)' : 'no output');
}

// 5. An aborted turn must never be retried.
{
  const { parsed } = await runHook([user, assistantAborted]);
  check('aborted turn is not retried', parsed === null, parsed ? 'blocked (wrong)' : 'no output');
}

// 6. A new user message after the last reply stops the retry loop.
{
  const { parsed } = await runHook([
    user,
    assistantError,
    { role: 'user', content: [{ type: 'text', text: 'never mind' }], timestamp: Date.now() },
  ]);
  check('user interjection stops the loop', parsed === null, parsed ? 'blocked (wrong)' : 'no output');
}

// 7. The retry bound is honoured.
{
  const { parsed } = await runHook([user, assistantError], {
    env: { MCODE_RETRY_MAX_RETRIES: '0' },
  });
  check('MCODE_RETRY_MAX_RETRIES is honoured', parsed === null, parsed ? 'blocked (wrong)' : 'no output');
}

// 8. The kill switch works.
{
  const { parsed } = await runHook([user, assistantError], {
    env: { MCODE_RETRY_DISABLED: '1' },
  });
  check('MCODE_RETRY_DISABLED turns the hook off', parsed === null, parsed ? 'blocked (wrong)' : 'no output');
}

// 9. A turn the model recovered from is not retried. The failed tool result
//     belongs to an earlier step of the same turn: the model produced its
//     final answer after it, so the operation already succeeded and a retry
//     would repeat its side effects.
{
  const { parsed } = await runHook([user, toolRateLimited, assistantOk]);
  check(
    'a recovered turn is not retried',
    parsed === null,
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

// 10. A tool call that failed and was the last thing the turn did is still
//     retried — that is the case the hook exists for.
{
  const { parsed } = await runHook([user, assistantToolUse, toolRateLimited]);
  check(
    'a failure at the end of the turn is retried',
    parsed?.decision === 'block' && /rate limit/i.test(parsed?.reason ?? ''),
    parsed ? 'blocked' : 'no output',
  );
}

// 11. A permanent turn error is not retried. The turn error goes through the
//     same classifier as a tool failure, so a rejected credential is left
//     alone instead of being retried eight times.
{
  const { parsed } = await runHook([
    user,
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: '401 Unauthorized: the credential was rejected',
      timestamp: Date.now(),
    },
  ]);
  check(
    'a permanent turn error is not retried',
    parsed === null,
    parsed ? JSON.stringify(parsed).slice(0, 80) : 'no output',
  );
}

// 12. The retry budget is finite: the hook grants the configured number of
//     retries and then ends the turn.
{
  const home = mkdtempSync(join(tmpdir(), 'retry-hook-test-'));
  const env = { MCODE_RETRY_MAX_RETRIES: '2' };
  const first = await runHook([user, assistantError], { home, env });
  const second = await runHook([user, assistantError], { home, env });
  const third = await runHook([user, assistantError], { home, env });
  check(
    'the first retry is granted',
    first.parsed?.decision === 'block',
    first.parsed ? 'blocked' : 'no output',
  );
  check(
    'the second retry is granted',
    second.parsed?.decision === 'block',
    second.parsed ? 'blocked' : 'no output',
  );
  check(
    'the budget ends the loop',
    third.parsed === null,
    third.parsed ? JSON.stringify(third.parsed).slice(0, 80) : 'no output',
  );
}

// 13. `stop_hook_active` is honoured. The runtime re-enters the hook with
//     the flag set when a Stop block already continued the turn, and the
//     continuations granted inside one turn are counted apart from the
//     retry episode: a turn that recovers and then fails again still ends.
{
  const home = mkdtempSync(join(tmpdir(), 'retry-hook-test-'));
  const env = { MCODE_RETRY_MAX_RETRIES: '3' };
  const reEntry = { stop_hook_active: true };
  const run = (messages) => runHook(messages, { home, env, payload: reEntry });

  const first = await run([user, assistantError]);
  await run([user, assistantOk]);
  const second = await run([user, assistantError]);
  await run([user, assistantOk]);
  const third = await run([user, assistantError]);
  await run([user, assistantOk]);
  const fourth = await run([user, assistantError]);

  check(
    'the first three continuations of a turn are granted',
    first.parsed?.decision === 'block' &&
      second.parsed?.decision === 'block' &&
      third.parsed?.decision === 'block',
    `first=${first.parsed?.decision} second=${second.parsed?.decision} third=${third.parsed?.decision}`,
  );
  check(
    'a re-entry past the per-turn budget does not block',
    fourth.parsed === null,
    fourth.parsed ? JSON.stringify(fourth.parsed).slice(0, 80) : 'no output',
  );
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
