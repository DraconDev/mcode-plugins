/**
 * Credential resolution.
 *
 * The credentials live in pi's auth store (`~/.pi/agent/auth.json`), so pi and
 * mcode share one login. The environment is checked first, because that is the
 * usual way to override for a one-off.
 *
 * pi's store shape:
 *   "agnes":       { "type": "api_key", "key": "..." }
 *   "openai-codex":{ "type": "oauth", "access": "...", "refresh": "...",
 *                    "expires": 1234, "accountId": "..." }
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PI_AUTH_FILE = join(homedir(), '.pi', 'agent', 'auth.json');

export function readPiAuth() {
  try {
    const parsed = JSON.parse(readFileSync(PI_AUTH_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve an API key for an endpoint.
 *
 * Order: environment variable, then the exact provider entry in pi's store,
 * then the `agnes` entry as a fallback (pi-agnes-tools does the same, so one
 * key works for both regions).
 */
export function resolveApiKey(endpoint, apiKeyEnv) {
  const fromEnv = process.env[apiKeyEnv]?.trim();
  if (fromEnv) return { key: fromEnv, source: `env:${apiKeyEnv}` };

  const auth = readPiAuth();
  const entry = auth[endpoint] ?? auth.agnes;
  if (entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim()) {
    return { key: entry.key.trim(), source: `pi:${endpoint in auth ? endpoint : 'agnes'}` };
  }
  if (typeof entry === 'string' && entry.trim()) {
    return { key: entry.trim(), source: `pi:${endpoint in auth ? endpoint : 'agnes'}` };
  }
  return { key: null, source: null };
}
