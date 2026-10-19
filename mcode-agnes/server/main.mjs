#!/usr/bin/env node
/**
 * mcode-agnes — MCP stdio server.
 *
 * Exposes Agnes AI image and video generation to MiniMax Code. The API key
 * comes from AGNES_API_KEY or AGNES_CN_API_KEY, or from pi's auth store if you
 * already sign in to Agnes there.
 */

import { createMcpServer } from './mcp-server.mjs';
import { createTools } from './tools.mjs';
import { resolveWorkspaceDir } from './workspace.mjs';

const tools = createTools({
  workspaceCwd: resolveWorkspaceDir(),
});

const server = createMcpServer({
  name: 'mcode-agnes',
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
