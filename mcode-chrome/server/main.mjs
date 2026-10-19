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
import { createSession } from './session.mjs';
import { createTools } from './tools.mjs';
import { resolveWorkspaceDir } from './workspace.mjs';

const SERVER_NAME = 'mcode-chrome';
const SERVER_VERSION = '1.0.0';

/** Protocol revisions this server can speak, newest first. */
const SUPPORTED_PROTOCOLS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const DEFAULT_PROTOCOL = '2025-06-18';

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

class McpServer {
  #tools = new Map();
  #protocol = DEFAULT_PROTOCOL;

  constructor() {
    this.bridge = new ChromeBridge();
    this.session = createSession();
    this.extensionPath = resolveExtensionPath();
    this.workspaceCwd = resolveWorkspaceDir();

    for (const tool of createTools({
      bridge: this.bridge,
      session: this.session,
      extensionPath: this.extensionPath ?? '(pi-chrome package not found)',
      workspaceCwd: this.workspaceCwd,
    })) {
      this.#tools.set(tool.name, tool);
    }
  }

  async start() {
    await this.bridge.start();
    log(
      `bridge ${this.bridge.mode} at ${this.bridge.url} | session ${this.session.sessionKey} | ` +
        `extension ${this.extensionPath ?? 'not found'}`,
    );
  }

  #write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  #result(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  #error(id, code, message, data) {
    this.#write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  async handle(message) {
    const { id, method, params } = message;

    // Notifications carry no id and expect no response.
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') log('client initialized');
      return;
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          this.#protocol = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
          this.#result(id, {
            protocolVersion: this.#protocol,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
          return;
        }
        case 'ping':
          this.#result(id, {});
          return;
        case 'tools/list':
          this.#result(id, {
            tools: [...this.#tools.values()].map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          });
          return;
        case 'tools/call': {
          const tool = this.#tools.get(params?.name);
          if (!tool) {
            this.#error(id, -32602, `Unknown tool: ${params?.name}`);
            return;
          }
          const result = await tool.handler(params?.arguments ?? {});
          this.#result(id, result);
          return;
        }
        default:
          this.#error(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      log(`error handling ${method}: ${error?.stack ?? error}`);
      // Tool failures are reported as tool results so the model can recover,
      // not as protocol errors that abort the turn.
      if (method === 'tools/call') {
        this.#result(id, {
          content: [{ type: 'text', text: `ERROR: ${error?.message ?? String(error)}` }],
          isError: true,
        });
        return;
      }
      this.#error(id, -32603, error?.message ?? String(error));
    }
  }

  listen() {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          void this.handle(message);
        } catch (error) {
          log(`skipping malformed message: ${error?.message ?? error}`);
        }
      }
    });
    process.stdin.on('end', () => {
      this.bridge.stop();
      process.exit(0);
    });
  }
}

const server = new McpServer();
await server.start();
server.listen();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.bridge.stop();
    process.exit(0);
  });
}
