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
 * Environment
 * -----------
 *   MCODE_RETRY_DISABLED   set to 1 to turn the hook into a no-op
 *   MCODE_RETRY_DELAY_MS   base backoff before the retry instruction (default 0)
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isRetryableFailure, retryInstruction, textOf } from './transient.mjs';

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
