#!/usr/bin/env node
/**
 * Generate `mcp/chrome.mcp.json` from the tool definitions the server actually
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
    chrome: {
      type: 'stdio',
      command: 'node',
      args: ['./server/main.mjs'],
      description:
        "Control the user's real, signed-in Chrome through the Pi Chrome Connector companion extension.",
      timeout: 180000,
      tools: TOOL_SCHEMAS,
    },
  },
};

const target = join(pluginRoot, 'mcp', 'chrome.mcp.json');
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(
  `wrote ${target} with ${TOOL_SCHEMAS.length} tool(s): ${TOOL_SCHEMAS.map((t) => t.name).join(', ')}\n`,
);
