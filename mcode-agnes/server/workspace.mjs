/**
 * Find the directory a relative path should be resolved against.
 *
 * MiniMax Code spawns plugin MCP servers with the *home* directory as their
 * working directory, and it does not pass a workspace path in the environment.
 * Resolving a relative path against that home directory silently writes files
 * to the wrong place.
 *
 * What is actually available:
 *
 * - `PWD` — the directory mcode was launched from. It reaches the plugin
 *   because mcode hands its own process environment to the server. This is the
 *   best available signal for "where the user is working".
 * - `roots/list` (MCP) — returns the home directory for plugin servers, so it
 *   is not usable for this.
 * - `cwd` — the home directory, which is the thing we are trying to correct.
 *
 * An explicit `MCODE_WORKSPACE` override still wins, and an explicit `baseDir`
 * argument on the tool wins over everything.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** Environment variables that may carry an explicit workspace path, best first. */
const WORKSPACE_ENV_VARS = [
  'MCODE_WORKSPACE',
  'MCODE_WORKSPACE_DIR',
  'MAVIS_WORKSPACE_DIR',
  'MINIMAX_WORKSPACE_DIR',
];

/** Environment variables that may carry an implicit workspace path, best first. */
const IMPLICIT_WORKSPACE_ENV_VARS = ['PWD'];

/**
 * @param {string} candidate
 * @param {string} cwd
 * @returns {string|null} the absolute path when it is an existing directory
 */
function asDirectory(candidate, cwd) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  try {
    return existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the directory relative paths should be anchored to.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.cwd]
 * @returns {string} an absolute path to an existing directory
 */
export function resolveWorkspaceDir({ env = process.env, cwd = process.cwd() } = {}) {
  for (const name of WORKSPACE_ENV_VARS) {
    const found = asDirectory(env?.[name], cwd);
    if (found) return found;
  }
  for (const name of IMPLICIT_WORKSPACE_ENV_VARS) {
    const found = asDirectory(env?.[name], cwd);
    if (found) return found;
  }
  return cwd;
}

/**
 * Resolve a user-supplied path against a base directory.
 *
 * Absolute paths are returned untouched, so a caller can always be explicit.
 *
 * @param {string} path
 * @param {string} baseDir
 * @returns {string}
 */
export function resolveAgainst(path, baseDir) {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}
