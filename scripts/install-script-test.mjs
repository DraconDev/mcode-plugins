#!/usr/bin/env node
/**
 * Test the plugin installer.
 *
 * The plugin name goes straight into a path that is then deleted recursively,
 * so a bad name must never reach the delete. These tests run the real script
 * against a sandboxed data directory.
 *
 *   node scripts/install-script-test.mjs
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const INSTALLER = join(REPO_ROOT, 'scripts', 'install-plugin.sh');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'mcode-install-test-'));

// The installer calls `mcode plugin list` and `mcode plugin add` to register
// the plugin. Left alone, the real CLI would bootstrap a whole runtime data
// directory inside the sandbox and register the plugin in the user's real
// marketplace — a test must not do either. A stub keeps it hermetic.
const stubBin = join(sandbox, 'bin');
mkdirSync(stubBin, { recursive: true });
const stubMcode = join(stubBin, 'mcode');
writeFileSync(stubMcode, '#!/bin/sh\n# stub: list nothing, accept any add\nexit 0\n');
chmodSync(stubMcode, 0o755);

/**
 * Run the installer with a sandboxed data directory.
 *
 * @param {string[]} args - arguments to pass to the script
 * @param {string} dataDir - the sandboxed MINIMAX_DATA_DIR
 */
function install(args, dataDir) {
  try {
    const stdout = execFileSync('bash', [INSTALLER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, MINIMAX_DATA_DIR: dataDir, PATH: `${stubBin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    };
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'mcode-install-test-'));

try {
  // A sandbox with two installed plugins, so a test can prove that installing
  // one does not disturb the others.
  const dataDir = join(sandbox, 'data');
  const pluginsDir = join(dataDir, 'plugins');
  mkdirSync(join(pluginsDir, 'mcode-agnes'), { recursive: true });
  mkdirSync(join(pluginsDir, 'mcode-chrome'), { recursive: true });
  writeFileSync(join(pluginsDir, 'mcode-agnes', 'keepme'), 'x');
  writeFileSync(join(pluginsDir, 'mcode-chrome', 'keepme'), 'x');

  // 1. Names that must be refused. An empty name resolves to the plugins
  //    directory itself, which would uninstall everything in it.
  for (const [label, name] of [
    ['an empty name', ''],
    ['a dot', '.'],
    ['a double dot', '..'],
    ['a parent path', '../..'],
    ['an absolute path', '/etc'],
    ['a path separator', 'mcode-agnes/../../..'],
    ['a name with a space', 'mcode agnes'],
  ]) {
    const result = install([name], dataDir);
    check(
      `${label} is refused`,
      result.code !== 0 && /invalid plugin name/.test(result.stderr),
      `exit=${result.code}`,
    );
  }

  // 2. Nothing may have been deleted by any of those attempts.
  check(
    'the installed plugins survived the rejected names',
    existsSync(join(pluginsDir, 'mcode-agnes', 'keepme')) &&
      existsSync(join(pluginsDir, 'mcode-chrome', 'keepme')),
    `plugins now: ${readdirSync(pluginsDir).join(', ')}`,
  );

  // 3. The target must stay inside the plugins directory.
  const outside = join(sandbox, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'precious'), 'x');
  const escaping = install(['../../../../../../../../tmp'], dataDir);
  check('an escaping name is refused', escaping.code !== 0, `exit=${escaping.code}`);
  check(
    'the file outside the plugins directory is untouched',
    existsSync(join(outside, 'precious')),
  );

  // 4. A valid name still installs, and only replaces its own plugin.
  const good = install(['mcode-agnes'], dataDir);
  check('a valid name installs', good.code === 0, `exit=${good.code} ${good.stderr.slice(0, 80)}`);
  check(
    'the plugin landed in the plugins directory',
    existsSync(join(pluginsDir, 'mcode-agnes', '.minimax-plugin', 'plugin.json')),
  );
  check(
    'the other plugin was not touched',
    existsSync(join(pluginsDir, 'mcode-chrome', 'keepme')),
  );
  check(
    'the replaced plugin was actually replaced',
    !existsSync(join(pluginsDir, 'mcode-agnes', 'keepme')),
  );

  // 5. A plugin with no MCP server gets no server directory. The shared
  //    modules are only useful to a plugin that serves MCP.
  const hookPlugin = install(['mcode-retry-on-error'], dataDir);
  check('a hook-only plugin installs', hookPlugin.code === 0, `exit=${hookPlugin.code}`);
  check(
    'a hook-only plugin gets no server directory',
    !existsSync(join(pluginsDir, 'mcode-retry-on-error', 'server')),
  );
  check(
    'a hook-only plugin does get its hooks',
    existsSync(join(pluginsDir, 'mcode-retry-on-error', 'hooks', 'hooks.json')),
  );

  // 6. A plugin with an MCP server does get the shared modules.
  check(
    'an MCP plugin gets the shared modules',
    existsSync(join(pluginsDir, 'mcode-agnes', 'server', 'retry.mjs')) &&
      existsSync(join(pluginsDir, 'mcode-agnes', 'server', 'mcp-server.mjs')),
  );

  // 7. The licence travels with the plugin.
  check(
    'the licence is installed with the plugin',
    existsSync(join(pluginsDir, 'mcode-agnes', 'LICENSE')),
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
