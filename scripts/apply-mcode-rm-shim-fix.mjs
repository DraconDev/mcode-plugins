#!/usr/bin/env node
/**
 * Repair the recoverable-delete `rm` shim that MiniMax Code seeds into the
 * runtime data dir.
 *
 * The bug
 * --------
 * MiniMax Code puts `<dataDir>/shims/rm` ahead of /bin/rm on the agent's PATH
 * so every delete lands in the platform trash instead of being unlinked. The
 * shim is generated from a template in the mcode bundle whose shebang is
 * hardcoded to `#!/bin/bash`. On a system without /bin/bash — NixOS, and this
 * machine in particular, where bash lives at /run/current-system/sw/bin/bash —
 * the shim fails to exec at all:
 *
 *     /home/dracon/.minimax/shims/rm: /bin/bash: bad interpreter: No such file or directory
 *
 * Every `rm` in agent bash dies before it reaches mavis-trash.
 *
 * The fix
 * -------
 * Change the template's shebang to `#!/usr/bin/env bash`, which resolves bash
 * through PATH on both Nix-style and conventional systems. The app re-seeds
 * the on-disk shim whenever it differs from the template, so patching the
 * template is what makes the fix stick.
 *
 * This script is idempotent: it patches the template if needed, then re-seeds
 * the live shim from the patched template so the fix applies immediately
 * rather than at the next session start.
 *
 * Re-run it after `mcode update` — the bundle is replaced wholesale there, so
 * the fix has to be re-applied.
 *
 *   node scripts/apply-mcode-rm-shim-fix.mjs [--check]
 */

import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const BROKEN = '#!/bin/bash\n# Managed by MiniMax Code. Do not edit.';
const FIXED = '#!/usr/bin/env bash\n# Managed by MiniMax Code. Do not edit.';

const checkOnly = process.argv.includes('--check');

const DATA_DIR = process.env.MINIMAX_DATA_DIR ?? join(homedir(), '.minimax');

/** Where mcode may be installed. */
const PACKAGE_ROOTS = [
  process.env.MCODE_PACKAGE_ROOT,
  join(homedir(), '.npm-global', 'lib', 'node_modules'),
  join(homedir(), '.local', 'lib', 'node_modules'),
  '/usr/local/lib/node_modules',
  '/usr/lib/node_modules',
].filter(Boolean);

function findPackageRoot() {
  for (const root of PACKAGE_ROOTS) {
    const candidate = join(root, '@minimax-ai', 'code');
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/** The template lives in a minified chunk; the chunk name can change per release. */
function findTemplate() {
  const packageRoot = findPackageRoot();
  if (!packageRoot) return null;
  const chunksDir = join(packageRoot, 'chunks');
  if (!existsSync(chunksDir)) return null;

  for (const file of readdirSync(chunksDir)) {
    if (!file.endsWith('.js')) continue;
    const path = join(chunksDir, file);
    const source = readFileSync(path, 'utf8');
    if (source.includes(BROKEN) || source.includes(FIXED)) {
      const index = source.indexOf('var qur=`');
      const template = index >= 0 ? source.slice(index + 'var qur=`'.length) : null;
      return { path, source, template };
    }
  }
  return null;
}

const found = findTemplate();
if (!found) {
  console.error(
    'Could not locate the mcode shim template.\n' +
      'Either @minimax-ai/code is not installed where expected, or this version\n' +
      'has changed the template. Search the bundle for "Managed by MiniMax Code".',
  );
  process.exit(1);
}

const alreadyFixed = found.source.includes(FIXED);

if (checkOnly) {
  console.log(
    alreadyFixed
      ? `OK  shim template is patched: ${found.path}`
      : `BAD shim template still uses #!/bin/bash: ${found.path}`,
  );
  process.exit(alreadyFixed ? 0 : 1);
}

if (!alreadyFixed) {
  // Exactly one occurrence is expected; the shebang is the first line of the
  // template, so the surrounding text keeps the match unambiguous.
  const occurrences = found.source.split(BROKEN).length - 1;
  if (occurrences !== 1) {
    console.error(`ABORT: expected 1 template occurrence, found ${occurrences}.`);
    process.exit(1);
  }
  writeFileSync(found.path, found.source.replace(BROKEN, FIXED));
  console.log(`patched template: ${found.path}`);
} else {
  console.log(`template already patched: ${found.path}`);
}

// Re-seed the live shim from the patched template so the fix is live now.
const templateMatch = readFileSync(found.path, 'utf8').match(/var qur=`([\s\S]*?)`;/);
if (!templateMatch) {
  console.error('ABORT: could not extract the template body from the patched bundle.');
  process.exit(1);
}

const shimPath = join(DATA_DIR, 'shims', 'rm');
if (existsSync(dirname(shimPath))) {
  writeFileSync(shimPath, templateMatch[1]);
  chmodSync(shimPath, 0o755);
  console.log(`re-seeded live shim: ${shimPath}`);
} else {
  console.log(`note: ${dirname(shimPath)} does not exist; the app will seed the shim itself.`);
}

const trash = join(DATA_DIR, 'bin', 'mavis-trash');
console.log(
  existsSync(trash)
    ? `trash runtime present: ${trash}`
    : `WARNING: trash runtime missing at ${trash} — the shim will refuse to delete.`,
);

console.log('\nVerify with:  printf probe > /tmp/probe && rm /tmp/probe && echo "rm works"');
