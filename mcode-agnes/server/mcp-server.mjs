/**
 * A minimal MCP server over stdio.
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout, which is the MCP stdio
 * framing. Only protocol messages go to stdout; everything else goes to
 * stderr, because anything else on stdout corrupts the stream.
 *
 * Zero dependencies on purpose: the plugins have to run from a plain `node`
 * executable with nothing installed alongside them.
 */

import { createInterface } from 'node:readline';

const SUPPORTED_PROTOCOLS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const DEFAULT_PROTOCOL = '2025-06-18';

/**
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.version
 * @param {Array<{name: string, description: string, inputSchema: object, handler: (args: any) => Promise<any>}>} options.tools
 * @param {() => Promise<void>} [options.onStart]
 * @param {() => void} [options.onStop]
 */
export function createMcpServer({ name, version, tools, onStart, onStop }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const log = (...args) => process.stderr.write(`[${name}] ${args.join(' ')}\n`);

  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const result = (id, payload) => write({ jsonrpc: '2.0', id, result: payload });
  const failure = (id, code, message) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(message) {
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
          const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
            ? requested
            : DEFAULT_PROTOCOL;
          result(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
          });
          return;
        }
        case 'ping':
          result(id, {});
          return;
        case 'tools/list':
          result(id, {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          });
          return;
        case 'tools/call': {
          const tool = byName.get(params?.name);
          if (!tool) {
            failure(id, -32602, `Unknown tool: ${params?.name}`);
            return;
          }
          result(id, await tool.handler(params?.arguments ?? {}));
          return;
        }
        default:
          failure(id, -32601, `Method not found: ${method}`);
      }
    } catch (error) {
      log(`error handling ${method}: ${error?.stack ?? error}`);
      // Tool failures are reported as tool results so the model can recover,
      // not as protocol errors that abort the turn.
      if (method === 'tools/call') {
        result(id, {
          content: [{ type: 'text', text: `ERROR: ${error?.message ?? String(error)}` }],
          isError: true,
        });
        return;
      }
      failure(id, -32603, error?.message ?? String(error));
    }
  }

  return {
    async start() {
      await onStart?.();
      log(`ready with ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`);
    },
    listen() {
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      input.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          void handle(JSON.parse(trimmed));
        } catch (error) {
          log(`skipping malformed message: ${error?.message ?? error}`);
        }
      });
      input.on('close', () => {
        onStop?.();
        process.exit(0);
      });
    },
    stop() {
      onStop?.();
    },
  };
}
