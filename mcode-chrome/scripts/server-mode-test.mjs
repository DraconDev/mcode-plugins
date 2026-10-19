#!/usr/bin/env node
/**
 * Server-mode protocol test.
 *
 * Proves the plugin works with NO pi session involved: this process owns the
 * bridge port, and a mock companion extension speaks the real wire protocol
 * against it — poll /next, receive a command, post the result back.
 *
 * This is the exact code path pi-chrome uses, minus Chrome itself, so it covers
 * the one branch a live test cannot reach while another session owns the port.
 *
 *   node scripts/server-mode-test.mjs
 */

import { ChromeBridge } from '../server/bridge.mjs';

const PORT = Number(process.env.TEST_PORT ?? 17399);
const URL = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
};

/** A mock companion extension: polls /next, answers /result. */
function startMockCompanion(onCommand) {
  let stopped = false;

  const poll = async () => {
    while (!stopped) {
      try {
        const response = await fetch(`${URL}/next?name=MockConnector`);
        const payload = await response.json();
        if (payload.type === 'command') {
          let outcome;
          try {
            outcome = { ok: true, result: onCommand(payload.command) };
          } catch (error) {
            // The real extension posts ok:false with a reason, rather than
            // leaving the command hanging.
            outcome = { ok: false, error: error?.message ?? String(error) };
          }
          await fetch(`${URL}/result`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: payload.command.id, ...outcome }),
          });
        }
      } catch {
        // Server went away; the loop exits via `stopped`.
      }
    }
  };

  const loop = poll();
  return { stop: () => { stopped = true; void loop; } };
}

const bridge = new ChromeBridge({ port: PORT, url: URL });
await bridge.start();

check('bridge takes ownership of the port', bridge.mode === 'server', `mode=${bridge.mode}`);

const statusResponse = await fetch(`${URL}/status`);
const status = await statusResponse.json();
check('GET /status answers', statusResponse.status === 200, `mode=${status.mode}`);

const companion = startMockCompanion((command) => ({
  echoedAction: command.action,
  echoedParams: command.params,
  tabs: [{ id: 7, title: 'Mock Tab', url: 'https://example.com', active: true }],
}));

// Give the companion a moment to register its first poll.
await new Promise((resolve) => setTimeout(resolve, 150));

const afterPoll = await (await fetch(`${URL}/status`)).json();
check(
  'companion poll registers the client',
  afterPoll.connected === true && afterPoll.clientName === 'MockConnector',
  `connected=${afterPoll.connected} client=${afterPoll.clientName}`,
);

// The real round trip: send a command, get the companion's result back.
const result = await bridge.send('tab.list', { sessionKey: 'mcode:test' });
check(
  'command round-trips through /next and /result',
  result?.echoedAction === 'tab.list' && result?.tabs?.[0]?.id === 7,
  JSON.stringify(result),
);

const params = result?.echoedParams ?? {};
check(
  'session key reaches the wire',
  params.sessionKey === 'mcode:test',
  `sessionKey=${params.sessionKey}`,
);

// A command that fails on the companion must surface as a rejected promise.
const failing = startMockCompanion(() => {
  throw new Error('mock extension failure');
});
await new Promise((resolve) => setTimeout(resolve, 100));
let rejection = '';
try {
  await bridge.send('page.click', {});
} catch (error) {
  rejection = error?.message ?? String(error);
}
check('companion failures reject with the reason', /mock extension failure/.test(rejection), rejection);

failing.stop();
companion.stop();
bridge.stop();

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} checks passed\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
