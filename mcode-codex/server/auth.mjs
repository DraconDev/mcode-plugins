/**
 * ChatGPT subscription credential handling.
 *
 * Two sources, in this order:
 *
 *   1. The environment — `CODEX_IMAGE_ACCESS_TOKEN`, and optionally
 *      `CODEX_IMAGE_ACCOUNT_ID`. This is the standalone path: it needs
 *      nothing but this plugin, and it is how most people will supply a
 *      credential.
 *   2. pi's auth store (`~/.pi/agent/auth.json`), under `openai-codex`:
 *
 *        "openai-codex": { "type": "oauth", "access": "...", "refresh": "...",
 *                          "expires": 1750000000000, "accountId": "..." }
 *
 *      A convenience for people who already sign in to the image provider
 *      through pi — one login, two agents. It is not a dependency: without
 *      pi, the environment variable alone is enough.
 *
 * A token from pi's store is refreshed when it has expired. The refreshed
 * token is held in memory only — this plugin does not write back to pi's
 * auth file, so it cannot corrupt another tool's state. pi refreshes its own
 * copy when it next needs one.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { extractImageAccountId, refreshAccessToken } from './codex.mjs';

export const PI_AUTH_FILE = join(homedir(), '.pi', 'agent', 'auth.json');

function readPiAuth() {
  try {
    const parsed = JSON.parse(readFileSync(PI_AUTH_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function fromEnv() {
  const access = process.env.CODEX_IMAGE_ACCESS_TOKEN?.trim();
  const accountId = process.env.CODEX_IMAGE_ACCOUNT_ID?.trim();
  if (!access) return null;
  return {
    access,
    refresh: null,
    expires: null,
    accountId: accountId ?? safeAccountId(access),
    source: 'env',
  };
}

function safeAccountId(token) {
  try {
    return extractImageAccountId(token);
  } catch {
    return null;
  }
}

/**
 * Resolve a usable credential, refreshing it when the stored one has expired.
 *
 * @returns {Promise<{ access: string, accountId: string, source: string, refreshed: boolean }>}
 */
export async function resolveCodexCredential({ allowRefresh = true } = {}) {
  // The environment is checked first. It is the standalone path — it needs
  // nothing but this plugin — and it is how a caller who has never heard of
  // pi supplies a credential. pi's store is a convenience for people who
  // already keep one, not a dependency.
  let credential = fromEnv();

  if (!credential) {
    const auth = readPiAuth();
    const entry = auth['openai-codex'];
    if (entry && typeof entry === 'object' && typeof entry.access === 'string' && entry.access) {
      credential = {
        access: entry.access,
        refresh: typeof entry.refresh === 'string' ? entry.refresh : null,
        expires: typeof entry.expires === 'number' ? entry.expires : null,
        accountId: typeof entry.accountId === 'string' ? entry.accountId : null,
        source: 'pi:openai-codex',
      };
    }
  }

  if (!credential) {
    throw new Error(
      'No ChatGPT image credential found. Set CODEX_IMAGE_ACCESS_TOKEN in the environment ' +
        '(and CODEX_IMAGE_ACCOUNT_ID if you want to be explicit), or sign in to the Codex ' +
        'image provider in pi, which stores an OAuth credential under "openai-codex" in ' +
        '~/.pi/agent/auth.json.',
    );
  }

  const expired =
    credential.expires !== null && credential.expires !== undefined && credential.expires <= Date.now();

  if (!expired) {
    const accountId = credential.accountId ?? safeAccountId(credential.access);
    if (!accountId) {
      throw new Error(
        'The ChatGPT image credential has no account id. Set CODEX_IMAGE_ACCOUNT_ID, or ' +
          'sign in again for the image provider in pi.',
      );
    }
    return { ...credential, accountId, refreshed: false };
  }

  if (!allowRefresh || !credential.refresh) {
    throw new Error(
      'The ChatGPT image credential has expired. Set a fresh CODEX_IMAGE_ACCESS_TOKEN, or ' +
        'sign in again for the image provider in pi.',
    );
  }

  const refreshed = await refreshAccessToken(credential.refresh);
  return { ...refreshed, source: credential.source, refreshed: true };
}
