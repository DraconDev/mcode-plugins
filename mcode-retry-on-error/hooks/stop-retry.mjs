#!/usr/bin/env node
/**
 * Stop hook — keep a MiniMax Code turn going when it ended in an error or a
 * rate-limited tool call.
 *
 * The MiniMax Code plugin hook format is Claude-Code compatible: the `Stop`
 * event fires when the agent tries to end its turn, and returning
 *
 *     { "decision": "block", "reason": "..." }
 *
 * does not end the turn — it feeds the reason back to the model and lets it
 * continue. That is a continuation, not a replay of the user's prompt, so
 * side effects from earlier tool calls are not repeated blindly.
 *
 * How it decides
 * --------------
 * The hook payload carries `stop_hook_active` and `last_assistant_message`,
 * but not the turn's outcome, so the hook reads the session transcript
 * (`messages.jsonl`) and looks at the tail:
 *
 *   assistant.stopReason === "aborted"  -> the user cancelled. Never retry.
 *   assistant.stopReason === "error"    -> the turn failed. Retry.
 *   last toolResult.isError             -> a tool call failed. Retry when the
 *                                          failure looks transient (rate
 *                                          limit, quota, timeout, 5xx, network).
 *   a user message after the last reply -> the user has spoken. Reset and stop.
 *
 * Safety boundaries
 * -----------------
 *   - An aborted turn is never retried.
 *   - A clean turn resets the retry state, so the next failure starts fresh.
 *   - A new user message resets the retry state — the same escape hatch pi's
 *     `pi-retry-on-error` gives ("the user starts another prompt").
 *   - The in-hook delay is capped so the hook always finishes inside its
 *     10s timeout; a longer backoff is handed to the tool instead.
 *   - Any internal error exits quietly, so a broken hook can never wedge a
 *     session.
 *
 * Environment
 * -----------
 *   MCODE_RETRY_DELAY_MS          base backoff delay (default 5000)
 *   MCODE_RETRY_BACKOFF_MULTIPLIER  multiplier per attempt (default 2)
 *   MCODE_RETRY_MAX_DELAY_MS      cap on a single delay (default 60000)
 *   MCODE_RETRY_MAX_RETRIES       attempts before giving up (default unlimited)
 *   MCODE_RETRY_MAX_DURATION_MS   total window before giving up (default unlimited)
 *   MCODE_RETRY_DISABLED          set to 1 to turn the hook into a no-op
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK_TIMEOUT_BUDGET_MS = 7_500;
const TAIL_BYTES = 256 * 1024;
const MAX_RECORDS = 60;

/** Transient-failure signatures worth retrying. */
const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /\b5\d\d\b/,
  /rate[\s_-]?limit/i,
  /too many requests/i,
  /quota/i,
  /overloaded/i,
  /capacity/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /timed? ?out/i,
  /timeout/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
];

const log = (...args) => process.stderr.write(`[mcode-retry-on-error] ${args.join(' ')}\n`);

const DEBUG = process.env.MCODE_RETRY_DEBUG === '1';
const trace = (...args) => {
  if (DEBUG) log('debug:', ...args);
};

const DATA_DIR =
  process.env.PLUGIN_DATA ??
  join(process.env.MINIMAX_DATA_DIR ?? join(homedir(), '.minimax'), 'plugin-data', 'mcode-retry-on-error');

/**
 * Configuration comes from a file, not the environment.
 *
 * MiniMax Code gives a hook process a whitelisted environment (PATH, HOME,
 * TMPDIR, ...) plus the PLUGIN_* variables — it does not pass the user's shell
 * environment through. So `MCODE_RETRY_*` variables set in a shell would never
 * reach this script. The file below is the real control surface; the
 * environment variables are honoured as well, so the hook can still be driven
 * by hand in a test.
 */
const CONFIG_FILE = join(DATA_DIR, 'config.json');

function readConfigFile() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const CONFIG = readConfigFile();

function configNumber(key, envName, fallback) {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  const fromFile = CONFIG[key];
  if (fromFile === null || fromFile === undefined || fromFile === '') return fallback;
  const parsed = Number(fromFile);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

const BASE_DELAY_MS = configNumber('delayMs', 'MCODE_RETRY_DELAY_MS', 5_000);
const BACKOFF_MULTIPLIER = (() => {
  const raw = CONFIG.backoffMultiplier ?? process.env.MCODE_RETRY_BACKOFF_MULTIPLIER;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 100) : 2;
})();
const MAX_DELAY_MS = configNumber('maxDelayMs', 'MCODE_RETRY_MAX_DELAY_MS', 60_000);
const MAX_RETRIES = configNumber('maxRetries', 'MCODE_RETRY_MAX_RETRIES', Number.POSITIVE_INFINITY);
const MAX_DURATION_MS = configNumber(
  'maxDurationMs',
  'MCODE_RETRY_MAX_DURATION_MS',
  Number.POSITIVE_INFINITY,
);
const DISABLED =
  CONFIG.enabled === false ||
  process.env.MCODE_RETRY_DISABLED === '1' ||
  CONFIG.disabled === true;
const FORCE_BLOCK = CONFIG.forceBlock === true || process.env.MCODE_RETRY_FORCE_BLOCK === '1';

/** Read the last chunk of a JSONL file and parse the trailing records. */
function readTailRecords(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  let raw;
  try {
    // `openSync` returns a numeric descriptor; `readSync` is the module-level
    // function that takes it.
    const fd = openSync(path, 'r');
    try {
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      raw = buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    trace('tail read failed:', error?.message ?? error);
    return [];
  }
  const lines = raw.split('\n');
  // The first line may be a partial record because we started mid-file.
  if (size > TAIL_BYTES) lines.shift();
  const records = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Partial or malformed line; ignore it.
    }
  }
  return records.slice(-MAX_RECORDS);
}

/** Find the session directory for a session id. */
function findSessionDir(sessionId) {
  if (!sessionId) return null;
  const suffix = `-session_${Buffer.from(sessionId, 'utf8').toString('base64')}`;
  const root = join(homedir(), '.minimax', 'v2', 'sessions');
  // Layout is sessions/<YYYY>/<MM>/<DD>/<time>-session_<base64 session id>.
  let years;
  try {
    years = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const year of years) {
    if (!year.isDirectory()) continue;
    let months;
    try {
      months = readdirSync(join(root, year.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory()) continue;
      let days;
      try {
        days = readdirSync(join(root, year.name, month.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory()) continue;
        let sessions;
        try {
          sessions = readdirSync(join(root, year.name, month.name, day.name), {
            withFileTypes: true,
          });
        } catch {
          continue;
        }
        for (const session of sessions) {
          if (session.isDirectory() && session.name.endsWith(suffix)) {
            return join(root, year.name, month.name, day.name, session.name);
          }
        }
      }
    }
  }
  return null;
}

function isTransient(text) {
  if (!text) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block.text === 'string') return block.text;
      return '';
    })
    .join('\n');
}

function loadState(sessionId) {
  const file = join(DATA_DIR, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  try {
    return { file, state: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { file, state: { attempts: 0, firstAttemptAt: 0 } };
  }
}

function saveState(file, state) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch (error) {
    log(`could not persist retry state: ${error?.message ?? error}`);
  }
}

function clearState(file) {
  try {
    writeFileSync(file, JSON.stringify({ attempts: 0, firstAttemptAt: 0 }), 'utf8');
  } catch {
    // Not fatal.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (DISABLED) return;

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');

  // Heartbeat: proves the hook process ran, whatever the decision is. Opt-in,
  // because the hook fires on every turn end.
  if (CONFIG.debug === true || DEBUG) {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(
        join(DATA_DIR, 'heartbeat.log'),
        `${new Date().toISOString()} event=${payload.hook_event_name} ` +
          `keys=${JSON.stringify(Object.keys(payload))}\n`,
        'utf8',
      );
    } catch {
      // Never let diagnostics break the hook.
    }
  }

  // Diagnostic escape hatch: force a block on every Stop, to verify that the
  // hook is wired up end to end. Checked before anything else so it cannot be
  // short-circuited by an unexpected transcript shape. Bounded, because an
  // unbounded block would loop the turn forever.
  if (FORCE_BLOCK) {
    const { file, state } = loadState(payload.session_id ?? 'diagnostic');
    const attempts = (state.attempts ?? 0) + 1;
    saveState(file, { attempts, firstAttemptAt: state.firstAttemptAt || Date.now() });
    if (attempts > 3) {
      clearState(file);
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        decision: 'block',
        reason:
          `The retry hook fired successfully (forceBlock diagnostic, attempt ${attempts} of 3). ` +
          'Turn it off by setting "forceBlock": false in the plugin config.',
      })}\n`,
    );
    return;
  }

  const sessionId = payload.session_id ?? payload.sessionId;
  if (!sessionId) {
    trace('no session id in payload');
    return;
  }

  const sessionDir = findSessionDir(sessionId);
  if (!sessionDir) {
    trace('session dir not found for', sessionId);
    return;
  }
  trace('session dir:', sessionDir);

  const records = readTailRecords(join(sessionDir, 'messages.jsonl'));
  trace('records read:', records.length);
  if (records.length === 0) return;

  const messages = records.map((record) => record?.message ?? record).filter(Boolean);

  // A user message after the last assistant reply means the user has taken over.
  const lastAssistantIndex = messages.findLastIndex(
    (message) => message.role === 'assistant',
  );
  if (lastAssistantIndex === -1) return;
  const lastAssistant = messages[lastAssistantIndex];
  if (messages.slice(lastAssistantIndex + 1).some((message) => message.role === 'user')) {
    return;
  }

  const { file, state } = loadState(sessionId);
  const lastToolResult = [...messages].reverse().find((message) => message.role === 'toolResult');

  // Aborted means the user cancelled — never retry that.
  if (lastAssistant.stopReason === 'aborted') {
    clearState(file);
    return;
  }

  let reason = null;
  let kind = null;

  if (lastAssistant.stopReason === 'error') {
    kind = 'turn error';
    reason = lastAssistant.errorMessage ?? lastAssistant.error ?? 'the turn ended with an error';
  } else if (lastToolResult?.isError) {
    const text = textOf(lastToolResult.content);
    if (isTransient(text)) {
      kind = 'transient tool failure';
      reason = `${lastToolResult.toolName ?? 'tool'} failed: ${text.slice(0, 400)}`;
    }
  }

  if (!reason) {
    // Clean turn: reset the counters so the next failure starts fresh.
    if (state.attempts) clearState(file);
    return;
  }

  const now = Date.now();
  const attempts = (state.attempts ?? 0) + 1;
  const firstAttemptAt = state.firstAttemptAt || now;

  if (Number.isFinite(MAX_RETRIES) && attempts > MAX_RETRIES) {
    log(`giving up after ${attempts - 1} retries (MCODE_RETRY_MAX_RETRIES)`);
    clearState(file);
    return;
  }
  if (Number.isFinite(MAX_DURATION_MS) && now - firstAttemptAt > MAX_DURATION_MS) {
    log(`giving up after ${Math.round((now - firstAttemptAt) / 1000)}s (MCODE_RETRY_MAX_DURATION_MS)`);
    clearState(file);
    return;
  }

  const wantedDelay = Math.min(
    BASE_DELAY_MS * BACKOFF_MULTIPLIER ** (attempts - 1),
    MAX_DELAY_MS,
  );
  const delay = Math.min(wantedDelay, HOOK_TIMEOUT_BUDGET_MS);

  saveState(file, { attempts, firstAttemptAt, lastDelayMs: wantedDelay });

  if (delay > 0) await sleep(delay);

  const retryNote =
    wantedDelay > delay
      ? ` Retry now; if it fails again, back off a further ${Math.round(wantedDelay / 1000)}s.`
      : '';

  process.stdout.write(
    `${JSON.stringify({
      decision: 'block',
      reason:
        `The previous attempt failed with a ${kind}: ${reason}\n\n` +
        `This is a transient failure (attempt ${attempts}). Retry the same operation now. ` +
        `Do not give up, do not change the approach, and do not apologise — just try again.` +
        retryNote,
    })}\n`,
  );
}

main().catch((error) => {
  // A broken hook must never wedge a session.
  log(`hook error, continuing normally: ${error?.message ?? error}`);
  process.exit(0);
});
