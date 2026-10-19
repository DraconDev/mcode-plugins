/**
 * Credential resolution.
 *
 * Two sources, in this order:
 *
 *   1. The environment — `AGNES_API_KEY` or `AGNES_CN_API_KEY`, depending on
 *      the endpoint. This is the standalone path: it needs nothing but this
 *      plugin, and it is how most people will supply a key.
 *   2. pi's auth store (`~/.pi/agent/auth.json`), as a convenience for people
 *      who already sign in to Agnes through pi — one login, two agents:
 *
 *        "agnes": { "type": "api_key", "key": "..." }
 *
 *      It is not a dependency: without pi, the environment variable alone is
 *      enough.
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
