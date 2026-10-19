/**
 * Session identity for the companion extension.
 *
 * The extension scopes its dedicated automation tab/window by `sessionKey`, so
 * every command from this session carries the same key and lands on the same
 * tab. A `mcode` session and a `pi` session use different keys, so they never
 * fight over one automation target even though they share the same Chrome.
 */

import { createHash } from 'node:crypto';

function workspaceId() {
  const explicit = process.env.MCODE_SESSION_ID ?? process.env.MCODE_WORKSPACE;
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 64);
  const cwd = process.env.MCODE_WORKSPACE ?? process.cwd();
  return createHash('sha1').update(cwd).digest('hex').slice(0, 12);
}

/**
 * @returns {{ sessionKey: string, groupTitle: string, workspaceId: string }}
 */
export function createSession() {
  const id = workspaceId();
  return {
    workspaceId: id,
    sessionKey: `mcode:${id}`,
    groupTitle: `MCode Session: ${id}`,
  };
}
