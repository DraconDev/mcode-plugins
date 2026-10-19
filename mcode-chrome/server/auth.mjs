/**
 * Authorization gate for Chrome actuation.
 *
 * The loopback bridge trusts any local process, so this module carries the gate
 * that `/chrome authorize` carries in pi. It is deliberately coarse: read-only
 * tools are always available, anything that changes the page needs authorization.
 *
 * State lives in a small JSON file so a decision survives MCP server restarts
 * within a session and across sessions. The default is "authorized", matching
 * the pi setup this mirrors (`pi-chrome-auto-auth` pins pi's gate to
 * indefinite). `revoke` flips it back and it stays flipped until `authorize`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DATA_DIR =
  process.env.MCODE_CHROME_DATA_DIR ??
  join(process.env.MCODE_DATA_DIR ?? join(homedir(), '.minimax'), 'plugin-data', 'mcode-chrome');

const STATE_FILE = join(DATA_DIR, 'auth.json');

/** Actions that only read from the page. Everything else needs authorization. */
export const READ_ONLY_ACTIONS = new Set([
  'tab.list',
  'tab.version',
  'page.snapshot',
  'page.inspect',
  'page.console.list',
  'page.network.list',
  'page.network.get',
  'automation.status',
]);

export function isReadOnlyAction(action) {
  return READ_ONLY_ACTIONS.has(action);
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Missing or unreadable state is not an error: fall back to the default.
  }
  return {};
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    // A read-only home directory must not break the session; the in-memory
    // state still applies for this process.
    process.stderr.write(
      `[mcode-chrome] could not persist auth state at ${STATE_FILE}: ${error?.message}\n`,
    );
  }
}

/**
 * @returns {{ authorized: boolean, until: number | "indefinite" | undefined, reason?: string }}
 */
export function authStatus() {
  const state = readState();
  const until = state.until;
  if (until === 'indefinite') return { authorized: true, until };
  if (until === 0) return { authorized: false, until, reason: 'Chrome control is locked.' };
  if (typeof until === 'number') {
    if (until > Date.now()) return { authorized: true, until };
    return { authorized: false, until, reason: 'The authorization window expired.' };
  }
  // No decision on record yet. Default to authorized: the user installed this
  // plugin to give the agent browser access, and the same posture they chose
  // for pi (pi-chrome-auto-auth pins pi's gate to indefinite). `revoke` flips
  // this to locked and it stays locked until `authorize` says otherwise.
  return { authorized: true, until: 'indefinite' };
}

/**
 * @param {number | "indefinite"} duration minutes, or the string "indefinite".
 */
export function authorize(duration) {
  const until =
    duration === 'indefinite' ? 'indefinite' : Date.now() + Number(duration) * 60_000;
  writeState({ until });
  return { authorized: true, until };
}

export function revoke() {
  writeState({ until: 0 });
  return { authorized: false, until: 0 };
}

export function assertAuthorized(action) {
  if (isReadOnlyAction(action)) return;
  const status = authStatus();
  if (!status.authorized) {
    throw new Error(
      'Chrome control is locked. Ask the user to call the `authorize` tool (for example ' +
        '`authorize` with duration "indefinite", or `authorize` with duration 15 for a ' +
        '15-minute window) before using tools that change the page.',
    );
  }
}

export { DATA_DIR, STATE_FILE };
