#!/usr/bin/env node
/**
 * Regression tests for the confirmed defects in this plugin.
 *
 * Every check feeds the real shape the companion extension produces through
 * the real function and asserts the fixed behaviour. The wire shapes are taken
 * from the extension source itself
 * (pi-chrome/extensions/chrome-profile-bridge/browser-extension/service_worker.js),
 * so the tests fail if the plugin drifts away from the wire again.
 *
 *   node scripts/regression-test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The auth gate resolves its state file when the module loads, so point it at
// an empty directory: the test must neither depend on nor disturb the real
// one.
process.env.MCODE_CHROME_DATA_DIR = await mkdtemp(join(tmpdir(), 'mcode-chrome-auth-'));

const { formatSnapshot, redact } = await import('../server/format.mjs');
const { createTools } = await import('../server/tools.mjs');

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'server', 'main.mjs');

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

// ---------------------------------------------------------------------------
// 1. Secret redaction: the three header shapes the extension returns.
// ---------------------------------------------------------------------------

// fetch: `entry.responseHeaders = Array.from(response.headers.entries())`.
const fetchShape = redact({
  responseHeaders: [
    ['x-api-key', 'sk-live-SECRET1'],
    ['authorization', 'Bearer SECRET2'],
    ['content-type', 'text/html'],
  ],
});
const fetchJson = JSON.stringify(fetchShape);
check(
  'fetch header pairs redact secret-named headers',
  !fetchJson.includes('SECRET1') && !fetchJson.includes('SECRET2'),
  fetchJson,
);
check('fetch header pairs keep harmless headers', fetchJson.includes('text/html'), fetchJson);

// XHR: `entry.responseHeadersText = this.getAllResponseHeaders()`.
const xhrShape = redact({
  responseHeadersText:
    'content-type: text/html\r\nx-csrf-token: SECRET3\r\nauthorization: Bearer SECRET4\r\n',
});
const xhrJson = JSON.stringify(xhrShape);
check(
  'raw header blocks redact secret-named headers',
  !xhrJson.includes('SECRET3') && !xhrJson.includes('SECRET4'),
  xhrJson,
);
check('raw header blocks keep harmless headers', xhrJson.includes('text/html'), xhrJson);

// Plain object shape must keep working.
const objectShape = redact({
  headers: { 'x-api-key': 'SECRET5', 'content-type': 'text/html' },
});
const objectJson = JSON.stringify(objectShape);
check(
  'object-shaped headers still redact',
  !objectJson.includes('SECRET5') && objectJson.includes('text/html'),
  objectJson,
);

// ---------------------------------------------------------------------------
// 2. A `__proto__` key must survive redaction without hijacking anything.
// ---------------------------------------------------------------------------

const withProto = redact(JSON.parse('{"__proto__":{"polluted":"yes"},"keep":"kept"}'));
check(
  'a __proto__ key survives redaction',
  Object.prototype.hasOwnProperty.call(withProto, '__proto__'),
  `keys=${Object.keys(withProto).join(',')}`,
);
check(
  'a __proto__ key does not become the prototype',
  withProto.polluted === undefined && Object.getPrototypeOf(withProto) === null,
  `polluted=${String(withProto.polluted)}`,
);
check('other keys are untouched', withProto.keep === 'kept', String(withProto.keep));

// ---------------------------------------------------------------------------
// 3. The session tab group must reach the wire for `tab` and `wait_for`.
// ---------------------------------------------------------------------------

const sent = [];
const fakeBridge = {
  send: async (action, params, timeoutMs) => {
    sent.push({ action, params, timeoutMs });
    if (action === 'tab.list') return [];
    return { ok: true };
  },
};

const session = { sessionKey: 'mcode:test', groupTitle: 'MCode Session: test' };
const tools = createTools({
  bridge: fakeBridge,
  session,
  extensionPath: '/tmp/extension',
  workspaceCwd: tmpdir(),
});
const byName = new Map(tools.map((tool) => [tool.name, tool]));

await byName.get('tab').handler({ action: 'new', url: 'https://example.com' });
const tabNew = sent.at(-1);
check(
  'tab new sends the session group title',
  tabNew.params.groupTitle === session.groupTitle,
  JSON.stringify(tabNew.params),
);
check(
  'tab new sends the session key',
  tabNew.params.sessionKey === session.sessionKey,
  JSON.stringify(tabNew.params),
);

await byName.get('tab').handler({ action: 'group', targetId: 42 });
check(
  'tab group sends the session group title',
  sent.at(-1).params.groupTitle === session.groupTitle,
  JSON.stringify(sent.at(-1).params),
);

await byName.get('wait_for').handler({ kind: 'selector', value: '#ready' });
const waitParams = sent.at(-1).params;
check(
  'wait_for sends the session group title',
  waitParams.sessionGroupTitle === session.groupTitle,
  JSON.stringify(waitParams),
);
check(
  'wait_for does not pull the target tab into the group',
  waitParams.joinSessionGroup === undefined,
  JSON.stringify(waitParams),
);

// ---------------------------------------------------------------------------
// 4. A full-page capture writes every tile, and says where they went.
// ---------------------------------------------------------------------------

const shotDir = await mkdtemp(join(tmpdir(), 'mcode-chrome-shot-'));
const tileDataUrl = (n) =>
  `data:image/png;base64,${Buffer.from(`tile-${n}`).toString('base64')}`;
fakeBridge.send = async () => ({
  fullPage: true,
  dimensions: { width: 800, height: 2400, viewportHeight: 800, dpr: 1 },
  tiles: [
    { y: 0, dataUrl: tileDataUrl(1) },
    { y: 800, dataUrl: tileDataUrl(2) },
    { y: 1600, dataUrl: tileDataUrl(3) },
  ],
});

const shot = await byName
  .get('screenshot')
  .handler({ path: 'shot.png', fullPage: true, baseDir: shotDir });
const shotFiles = (await readdir(shotDir)).sort();
check(
  'a full-page capture writes every tile',
  shotFiles.join(',') === 'shot-1.png,shot-2.png,shot-3.png',
  shotFiles.join(','),
);
check(
  'every written tile keeps its own content',
  (await readFile(join(shotDir, 'shot-2.png'), 'utf8')) === 'tile-2',
  await readFile(join(shotDir, 'shot-2.png'), 'utf8'),
);
const shotText = shot.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n');
check(
  'a full-page capture reports every written path',
  shotText.includes('shot-1.png') &&
    shotText.includes('shot-2.png') &&
    shotText.includes('shot-3.png'),
  shotText.replace(/\n/g, ' | '),
);
check('a full-page capture says "Saved to"', shotText.includes('Saved to'), shotText);
check(
  'a full-page capture returns every tile as an image',
  shot.content.filter((block) => block.type === 'image').length === 3,
  String(shot.content.filter((block) => block.type === 'image').length),
);

// ---------------------------------------------------------------------------
// 5. "Changed since last snapshot" renders the extension's diff entries.
// ---------------------------------------------------------------------------

const diffText = formatSnapshot({
  title: 'Example',
  url: 'https://example.com',
  diff: {
    changes: [
      { kind: 'url', before: 'https://a.example', after: 'https://b.example' },
      { kind: 'textChanged' },
      { kind: 'focus', before: 'e3', after: 'e9' },
    ],
    added: [{ uid: 'e9' }],
    removed: [],
    updated: [],
  },
});
check(
  'the changed section renders',
  diffText.includes('## Changed since last snapshot'),
  diffText.replace(/\n/g, ' | '),
);
check(
  'each change renders readably',
  diffText.includes('url: https://a.example → https://b.example') &&
    diffText.includes('textChanged') &&
    diffText.includes('focus: e3 → e9'),
  diffText.replace(/\n/g, ' | '),
);
check(
  'no change renders as "[object Object]"',
  !diffText.includes('[object Object]'),
  diffText.replace(/\n/g, ' | '),
);

// ---------------------------------------------------------------------------
// 6. A malformed stdin message must not kill the MCP server.
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

const port = await freePort();
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, MCODE_CHROME_BRIDGE_PORT: String(port) },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const exited = new Promise((resolveExit) => child.on('exit', (code) => resolveExit(code)));
child.stdin.write('null\n');
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  })}\n`,
);

const deadline = Date.now() + 10_000;
let initialize = null;
while (Date.now() < deadline) {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const message = JSON.parse(trimmed);
      if (message.id === 1) initialize = message;
    } catch {
      // Ignore a partial line; the next chunk completes it.
    }
  }
  if (initialize) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}

check(
  'a bare null message does not stop the server from answering',
  initialize?.result?.serverInfo?.name === 'mcode-chrome',
  initialize ? JSON.stringify(initialize.result ?? initialize.error) : stderr.slice(0, 400),
);

child.stdin.end();
const exitCode = await exited;
check('the server exits cleanly after stdin ends', exitCode === 0, `exit=${exitCode}`);

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
