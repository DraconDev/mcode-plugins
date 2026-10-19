#!/usr/bin/env node
/**
 * Generate `mcp/agnes.mcp.json` from the tool definitions the server actually
 * implements, so the declared tool list in the plugin manifest can never drift
 * from the running server.
 *
 *   node scripts/build-manifest.mjs
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_SCHEMAS } from '../server/tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');

const manifest = {
  $schema: '../../schemas/mcp-v1.schema.json',
  schemaVersion: 1,
  mcpServers: {
    agnes: {
      type: 'stdio',
      command: 'node',
      args: ['./server/main.mjs'],
      description:
        'Agnes AI image and video generation, with automatic retry on rate limits and transient failures.',
      timeout: 900000,
      tools: TOOL_SCHEMAS,
    },
  },
};

const target = join(pluginRoot, 'mcp', 'agnes.mcp.json');
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(
  `wrote ${target} with ${TOOL_SCHEMAS.length} tool(s): ${TOOL_SCHEMAS.map((t) => t.name).join(', ')}\n`,
);
