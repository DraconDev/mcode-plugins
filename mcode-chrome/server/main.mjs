#!/usr/bin/env node
/**
 * mcode-chrome — MCP stdio server.
 *
 * Exposes the user's real, signed-in Chrome to MiniMax Code through the
 * pi-chrome loopback bridge protocol, which the "Pi Chrome Connector"
 * companion extension already speaks.
 *
 * Transport is newline-delimited JSON-RPC 2.0 over stdio, which is the MCP
 * stdio framing. Only protocol messages go to stdout; diagnostics go to stderr,
 * because anything else on stdout corrupts the stream.
 *
 * Zero dependencies on purpose: the plugin has to run from a plain `node`
 * executable with nothing installed alongside it.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ChromeBridge } from './bridge.mjs';
import { createMcpServer } from './mcp-server.mjs';
import { createSession } from './session.mjs';
import { createTools } from './tools.mjs';
import { resolveWorkspaceDir } from './workspace.mjs';

const SERVER_NAME = 'mcode-chrome';
const SERVER_VERSION = '1.0.0';

const log = (...args) => process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);

/**
 * Locate the companion extension that the user already has loaded in Chrome.
 *
 * The extension id is derived from the unpacked extension's absolute path, so
 * this plugin deliberately does NOT ship its own copy: a second copy would
 * register as a second connector and race the first one for commands. Point at
 * the installed pi-chrome package instead.
 */
function resolveExtensionPath() {
  const override = process.env.MCODE_CHROME_EXTENSION_PATH;
  if (override && existsSync(override)) return resolve(override);

  const roots = [
    process.env.MCODE_CHROME_PACKAGE_ROOT,
    process.env.NODE_PATH?.split(':').filter(Boolean)[0],
    join(homedir(), '.npm-global', 'lib', 'node_modules'),
    join(homedir(), '.local', 'lib', 'node_modules'),
    join(homedir(), '.bun', 'install', 'global', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = join(
      root,
      'pi-chrome',
      'extensions',
      'chrome-profile-bridge',
      'browser-extension',
    );
    if (existsSync(join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

const bridge = new ChromeBridge();
const session = createSession();
const extensionPath = resolveExtensionPath();
const workspaceCwd = resolveWorkspaceDir();

const tools = createTools({
  bridge,
  session,
  extensionPath: extensionPath ?? '(pi-chrome package not found)',
  workspaceCwd,
});

// The shared stdio server owns the JSON-RPC framing. It skips messages that
// are not objects and never lets a rejected request take the process down,
// which is why this plugin does not hand-roll its own copy.
const server = createMcpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  tools,
  onStart: async () => {
    await bridge.start();
    log(
      `bridge ${bridge.mode} at ${bridge.url} | session ${session.sessionKey} | ` +
        `extension ${extensionPath ?? 'not found'}`,
    );
  },
  onStop: () => {
    bridge.stop();
  },
});

await server.start();
server.listen();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
