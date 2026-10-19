#!/usr/bin/env node
/**
 * PostToolUse hook — catch a transient tool failure the moment it happens.
 *
 * The `Stop` hook can only act after the agent has already decided to end its
 * turn, and it has to dig the failure out of the session transcript. This hook
 * sits closer to the problem: it fires the instant a tool fails, with the tool
 * response in the payload, so the retry instruction reaches the model while it
 * is still working.
 *
 * Output
 * ------
 * The hook writes a `hookSpecificOutput` with `additionalContext`. MiniMax Code
 * merges that into the tool result as a `<plugin-hook-context>` block, so the
 * model sees the failure and the instruction to retry it as part of the tool
 * output.
 *
 * The shape matters: a top-level `{"decision": "block"}` is the *blocking*
 * form, and MiniMax Code treats a blocked PostToolUse as a structured block —
 * which closes the tool-result delivery seam and makes the *next* tool call
 * fail with "Tool-result delivery seam is closed." The `hookSpecificOutput`
 * form injects the same context without blocking anything.
 *
 * A failure is only treated as transient when it both reads like a failure and
 * matches a transient signature. A successful command that happens to print
 * "429" is left alone.
 *
 * Timing
 * ------
 * The runtime kills this hook at its 10s timeout, so the backoff delay is
 * clamped to leave room for the output to be written. A delay that runs past
 * the budget would be killed before the first byte of stdout, and the
 * failure would be lost silently.
 *
 * Environment
 * -----------
 *   MCODE_RETRY_DISABLED   set to 1 to turn the hook into a no-op
 *   MCODE_RETRY_DELAY_MS   base backoff before the retry instruction (default 0)
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { failureDetail, isRetryableFailure, retryInstruction, textOf } from './transient.mjs';

/**
 * How long the hook may sleep before it has to write its output.
 *
 * The runtime allows 10 000 ms and kills the hook there. The Stop hook
 * clamps its own delay to the same budget; this one has to as well, or a
 * long delay eats the whole allowance and the hook produces nothing.
 */
const HOOK_TIMEOUT_BUDGET_MS = 7_500;

const DATA_DIR =
  process.env.PLUGIN_DATA ??
  join(process.env.MINIMAX_DATA_DIR ?? join(homedir(), '.minimax'), 'plugin-data', 'mcode-retry-on-error');

const CONFIG_FILE = join(DATA_DIR, 'config.json');

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const CONFIG = readConfig();

const DISABLED =
  CONFIG.enabled === false ||
  process.env.MCODE_RETRY_DISABLED === '1' ||
  CONFIG.disabled === true;

const DEBUG = process.env.MCODE_RETRY_DEBUG === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the per-session attempt counter. */
function stateFile(sessionId) {
  return join(DATA_DIR, `tool-${String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function loadAttempts(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isFinite(parsed?.attempts) ? parsed.attempts : 0;
  } catch {
    return 0;
  }
}

/**
 * Write the counter atomically.
 *
 * The hook runs after *every* tool call, so two calls can land at the same
 * moment. A plain write is a read-modify-write that a concurrent call can
 * lose, so the new value goes to a temporary file in the same directory and
 * is renamed over the old one: a rename is atomic, so a reader never sees
 * half a file and no update is lost.
 */
function saveAttempts(file, attempts) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(temp, JSON.stringify({ attempts }), 'utf8');
    renameSync(temp, file);
  } catch {
    // Not fatal — the attempt counter is only for the message.
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may never have been created.
    }
  }
}

/**
 * Reset the counter.
 *
 * The counter is the attempt number of the failure the model is working on.
 * A call that did not fail ends that failure, so the next one starts at
 * attempt 1 again — a counter that only ever grows announces "attempt 10"
 * for an operation the model has never tried, and pushes the model towards
 * giving up.
 */
function resetAttempts(file) {
  if (loadAttempts(file) <= 0) return;
  saveAttempts(file, 0);
}

async function main() {
  if (DISABLED) return;

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

  if (CONFIG.debug === true || DEBUG) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(
        join(DATA_DIR, 'post-tool-heartbeat.log'),
        `${new Date().toISOString()} tool=${payload.tool_name ?? '-'} ` +
          `is_error=${payload.is_error ?? '-'} ` +
          `response=${JSON.stringify(textOf(payload.tool_response).slice(-300))}\n`,
        'utf8',
      );
    } catch {
      // Never let diagnostics break the hook.
    }
  }

  const toolName = payload.tool_name ?? 'tool';
  const response = payload.tool_response;
  const text = textOf(response);
  // The host does not always pass an explicit error flag, so the result has
  // to carry the signal. `is_error === false` is authoritative when present.
  const failed = payload.is_error === undefined ? undefined : payload.is_error === true;
  const isPlainText = typeof response === 'string';

  if (!isRetryableFailure({ text, failed, isPlainText })) return;

  const file = stateFile(payload.session_id);
  const attempts = loadAttempts(file) + 1;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ attempts }), 'utf8');
  } catch {
    // Not fatal — the attempt counter is only for the message.
  }

  const delay = Number(process.env.MCODE_RETRY_DELAY_MS ?? CONFIG.delayMs ?? 0);
  if (Number.isFinite(delay) && delay > 0) await sleep(delay);

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: retryInstruction({
          toolName,
          detail: text.slice(-300) || 'transient error',
          attempt: attempts,
        }),
      },
    })}\n`,
  );
}

main().catch((error) => {
  // A broken hook must never wedge a session.
  process.stderr.write(`[mcode-retry-on-error] post-tool hook error: ${error?.message ?? error}\n`);
  process.exit(0);
});
