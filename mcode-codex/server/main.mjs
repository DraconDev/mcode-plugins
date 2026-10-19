#!/usr/bin/env node
/**
 * mcode-codex — MCP stdio server.
 *
 * Exposes ChatGPT subscription image generation to MiniMax Code, using the
 * OAuth credential already stored for pi.
 */

import { createHash } from 'node:crypto';

import { createMcpServer } from './mcp-server.mjs';
import { createTools } from './tools.mjs';
import { resolveWorkspaceDir } from './workspace.mjs';

const workspaceCwd = resolveWorkspaceDir();
const sessionKey = `mcode:${createHash('sha1').update(workspaceCwd).digest('hex').slice(0, 12)}`;

const tools = createTools({ workspaceCwd, sessionKey });

const server = createMcpServer({
  name: 'mcode-codex',
  version: '1.0.0',
  tools,
});

await server.start();
server.listen();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
