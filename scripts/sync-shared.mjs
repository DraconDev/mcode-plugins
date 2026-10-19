#!/usr/bin/env node
/**
 * Copy the shared modules into every plugin that uses them.
 *
 * `shared/` holds one copy of the retry core and the MCP stdio server. Each
 * plugin needs its own copy on disk because a plugin is installed by copying
 * its directory somewhere else entirely — it has to be self-contained. This
 * script keeps those copies identical to the originals.
 *
 *   node scripts/sync-shared.mjs [--check]
 */

import { copyFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SHARED_DIR = join(REPO_ROOT, 'shared');
const checkOnly = process.argv.includes('--check');

if (!existsSync(SHARED_DIR)) {
  console.error(`No shared directory at ${SHARED_DIR}`);
  process.exit(1);
}

const sharedFiles = readdirSync(SHARED_DIR).filter((file) => file.endsWith('.mjs'));

// Every plugin that has a server/ directory consumes the shared modules.
const plugins = readdirSync(REPO_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('mcode-'))
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(REPO_ROOT, name, 'server')));

let drifted = 0;
for (const plugin of plugins) {
  const serverDir = join(REPO_ROOT, plugin, 'server');
  for (const file of sharedFiles) {
    const source = join(SHARED_DIR, file);
    const target = join(serverDir, file);
    const same =
      existsSync(target) &&
      readFileSync(source, 'utf8') === readFileSync(target, 'utf8');
    if (same) continue;
    drifted += 1;
    if (checkOnly) {
      console.log(`DRIFT  ${plugin}/server/${file}`);
      continue;
    }
    copyFileSync(source, target);
    console.log(`synced ${plugin}/server/${file}`);
  }
}

if (checkOnly) {
  console.log(
    drifted === 0
      ? `all shared modules are in sync across ${plugins.length} plugin(s)`
      : `${drifted} shared module copy/copies are out of sync`,
  );
  process.exit(drifted === 0 ? 0 : 1);
}

console.log(
  `shared modules synced across ${plugins.length} plugin(s): ${sharedFiles.join(', ')}`,
);
