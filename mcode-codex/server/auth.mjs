/**
 * ChatGPT subscription credential handling.
 *
 * The OAuth credential lives in pi's auth store under `openai-codex`:
 *
 *   "openai-codex": { "type": "oauth", "access": "...", "refresh": "...",
 *                     "expires": 1750000000000, "accountId": "..." }
 *
 * The refreshed token is held in memory only — this plugin does not write back
 * to pi's auth file, so it cannot corrupt another tool's state. pi refreshes
 * its own copy when it next needs one.
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
  const auth = readPiAuth();
  const entry = auth['openai-codex'];

  let credential = null;
  if (entry && typeof entry === 'object' && typeof entry.access === 'string' && entry.access) {
    credential = {
      access: entry.access,
      refresh: typeof entry.refresh === 'string' ? entry.refresh : null,
      expires: typeof entry.expires === 'number' ? entry.expires : null,
      accountId: typeof entry.accountId === 'string' ? entry.accountId : null,
      source: 'pi:openai-codex',
    };
  } else {
    credential = fromEnv();
  }

  if (!credential) {
    throw new Error(
      'No ChatGPT image credential found. Sign in to the Codex image provider in pi ' +
        '(that stores an OAuth credential under "openai-codex" in ~/.pi/agent/auth.json), ' +
        'or set CODEX_IMAGE_ACCESS_TOKEN in the environment.',
    );
  }

  const expired =
    credential.expires !== null && credential.expires !== undefined && credential.expires <= Date.now();

  if (!expired) {
    const accountId = credential.accountId ?? safeAccountId(credential.access);
    if (!accountId) {
      throw new Error('The ChatGPT image credential has no account id. Sign in again in pi.');
    }
    return { ...credential, accountId, refreshed: false };
  }

  if (!allowRefresh || !credential.refresh) {
    throw new Error(
      'The ChatGPT image credential has expired. Sign in again for the image provider in pi.',
    );
  }

  const refreshed = await refreshAccessToken(credential.refresh);
  return { ...refreshed, source: credential.source, refreshed: true };
}
