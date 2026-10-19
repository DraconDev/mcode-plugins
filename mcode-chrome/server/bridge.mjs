/**
 * Chrome profile bridge — owner-or-client over the pi-chrome loopback wire protocol.
 *
 * The user's real Chrome is reached through the "Pi Chrome Connector" companion
 * extension, which long-polls this bridge. The wire protocol is the one shipped
 * with pi-chrome (MIT) and is unchanged here:
 *
 *   GET  /status   -> { url, mode, connected, lastSeenAt, clientName, ... }
 *   POST /command  { action, params, timeoutMs } -> { ok: true, result } | { ok: false, error }
 *   GET  /next     -> { type: "command", command: { id, action, params } } | { type: "none" }
 *   POST /result   { id, ok, result | error } -> { ok: true }
 *
 * Two modes, so MiniMax Code and Pi can drive the same browser at once:
 *
 *   server  — we own the loopback port and broker commands to the extension.
 *   client  — another process (typically a running `pi` session) owns the port;
 *             we forward commands to that owner over POST /command.
 *
 * Ownership is resolved at startup and re-resolved if the owner disappears, so a
 * session that starts before `pi` still works and a session that starts after it
 * piggybacks instead of fighting for the port.
 *
 * Security posture is copied from pi-chrome on purpose:
 *   - the listener binds to 127.0.0.1 only; there is no network exposure.
 *   - /command is accepted only from a local process (no Origin, no sec-fetch-site).
 *   - /next and /result are accepted only from a chrome-extension:// origin.
 */

import { createServer } from 'node:http';

export const BRIDGE_HOST = process.env.MCODE_CHROME_BRIDGE_HOST ?? '127.0.0.1';
export const BRIDGE_PORT = Number(process.env.MCODE_CHROME_BRIDGE_PORT ?? 17318);
export const BRIDGE_URL =
  process.env.MCODE_CHROME_BRIDGE_URL ?? `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** An explicit BRIDGE_URL means "client only" — used for same-host debugging. */
const FORCED_CLIENT = Boolean(process.env.MCODE_CHROME_BRIDGE_URL);

function sendJson(response, status, body, extraHeaders) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders ?? {}),
  });
  response.end(JSON.stringify(body));
}

function readRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}

function corsHeadersFor(request) {
  const origin = String(request.headers.origin ?? '');
  if (!origin.startsWith('chrome-extension://')) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-expose-headers': 'x-pi-chrome-version',
    vary: 'origin',
  };
}

/** Browser-facing endpoints accept only the companion extension's origin. */
function isBrowserOriginAllowed(request) {
  const origin = String(request.headers.origin ?? '');
  if (origin) return origin.startsWith('chrome-extension://');
  const secFetchSite = String(request.headers['sec-fetch-site'] ?? '');
  return !secFetchSite || secFetchSite === 'none' || secFetchSite === 'same-origin';
}

/**
 * Command endpoints accept only local processes. A plain `fetch` from node sends
 * neither Origin nor sec-fetch-site; a page in Chrome sends both. Never add
 * those headers to a bridge request.
 */
function isLocalProcessRequest(request) {
  return !request.headers.origin && !request.headers['sec-fetch-site'];
}

function isOwnerUnreachable(error) {
  const message = error?.message ?? '';
  const code = error?.code ?? '';
  const causeCode = error?.cause?.code ?? '';
  return (
    /fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(message) ||
    code === 'ECONNREFUSED' ||
    causeCode === 'ECONNREFUSED' ||
    causeCode === 'ECONNRESET'
  );
}

export class ChromeBridge {
  #server;
  #pending = new Map();
  #queue = [];
  #waiters = [];
  #lastSeenAt;
  #clientName;
  #mode;
  #idCounter = 0;

  constructor({ host = BRIDGE_HOST, port = BRIDGE_PORT, url = BRIDGE_URL } = {}) {
    this.host = host;
    this.port = port;
    this.url = url;
  }

  get mode() {
    return this.#mode ?? 'starting';
  }

  /**
   * The extension is considered connected when it polled recently. MV3 service
   * workers pause between polls, so a real tool call — not a probe — is the
   * authoritative end-to-end health check.
   */
  get connected() {
    return this.#lastSeenAt !== undefined && Date.now() - this.#lastSeenAt < 5 * 60_000;
  }

  status() {
    return {
      url: this.url,
      mode: this.mode,
      connected: this.connected,
      lastSeenAt: this.#lastSeenAt,
      clientName: this.#clientName,
      queuedCommands: this.#queue.length,
      pendingCommands: this.#pending.size,
    };
  }

  /**
   * Status including the owner's view of the companion extension.
   *
   * In client mode we never see the extension's polls ourselves — the port
   * owner does — so we ask the owner. Without this, "connected" would always
   * read false whenever another session owns the bridge.
   */
  async probeStatus() {
    if (this.#mode !== 'client') return this.status();
    try {
      const response = await fetch(`${this.url}/status`);
      if (!response.ok) return this.status();
      const remote = await response.json();
      return {
        ...this.status(),
        connected: Boolean(remote.connected),
        lastSeenAt: remote.lastSeenAt,
        clientName: remote.clientName,
        ownerMode: remote.mode,
      };
    } catch {
      return this.status();
    }
  }

  async start() {
    if (this.#server || this.#mode === 'client') return;
    if (FORCED_CLIENT) {
      this.#mode = 'client';
      return;
    }
    await this.#bindServerOrClient();
  }

  async #bindServerOrClient() {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        sendJson(response, 500, { error: error?.message ?? String(error) });
      });
    });

    try {
      await new Promise((resolveStart, rejectStart) => {
        server.once('error', rejectStart);
        server.listen(this.port, this.host, () => {
          server.off('error', rejectStart);
          resolveStart();
        });
      });
      this.#server = server;
      this.#mode = 'server';
    } catch (error) {
      server.close();
      if (error?.code !== 'EADDRINUSE') throw error;
      // Another session already owns the port. Use it as the shared machine-local
      // broker so several agents can control the same Chrome at once.
      this.#mode = 'client';
    }
  }

  /** Take over the port when the previous owner disappears mid-session. */
  async #tryPromoteToServer() {
    if (this.#mode !== 'client') return this.#mode === 'server';
    this.#mode = undefined;
    await this.#bindServerOrClient();
    return this.#mode === 'server';
  }

  stop() {
    if (this.#mode === 'client') {
      this.#mode = undefined;
      return;
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Chrome profile bridge stopped'));
    }
    this.#pending.clear();
    this.#queue = [];
    for (const waiter of this.#waiters) waiter(undefined);
    this.#waiters = [];
    this.#server?.close();
    this.#server = undefined;
    this.#mode = undefined;
  }

  async send(action, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
    if (this.#mode === 'client') return this.#sendViaOwner(action, params, timeoutMs, signal);
    return this.#sendLocal(action, params, timeoutMs, signal);
  }

  #sendLocal(action, params, timeoutMs, signal) {
    const id = `mcode-${Date.now().toString(36)}-${(this.#idCounter += 1).toString(36)}`;
    const command = { id, action, params };
    return new Promise((resolveCommand, rejectCommand) => {
      if (signal?.aborted) {
        rejectCommand(new Error('Chrome command aborted'));
        return;
      }
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
        this.#queue = this.#queue.filter((queued) => queued.id !== id);
        cleanup();
        rejectCommand(new Error('Chrome command aborted'));
      };
      const timer = setTimeout(() => {
        const entry = this.#pending.get(id);
        this.#pending.delete(id);
        this.#queue = this.#queue.filter((queued) => queued.id !== id);
        cleanup();
        rejectCommand(new Error(this.#timeoutMessage(entry, timeoutMs)));
      }, timeoutMs);

      this.#pending.set(id, {
        command,
        resolve: (value) => {
          cleanup();
          resolveCommand(value);
        },
        reject: (err) => {
          cleanup();
          rejectCommand(err);
        },
        timer,
      });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.#enqueue(command);
    });
  }

  /**
   * Distinguish the three failure modes so the agent is never left guessing:
   * the extension never polled, it polled but never picked the command up, or
   * it ran the command and never posted a result back.
   */
  #timeoutMessage(entry, timeoutMs) {
    const pollAgeMs = this.#lastSeenAt === undefined ? undefined : Date.now() - this.#lastSeenAt;
    if (entry?.deliveredAt) {
      return (
        `Timed out after ${timeoutMs}ms: the Chrome extension received the command but never ` +
        'returned a result. The action may be long-running, or the result post failed. ' +
        "Reload 'Pi Chrome Connector' at chrome://extensions and retry."
      );
    }
    if (pollAgeMs === undefined || pollAgeMs > 60_000) {
      return (
        `Timed out after ${timeoutMs}ms: the Chrome extension is not polling (last seen ` +
        `${pollAgeMs === undefined ? 'never' : `${Math.round(pollAgeMs / 1000)}s ago`}). ` +
        'Load the bundled browser-extension folder in your normal Chrome profile, keep that ' +
        'Chrome window open, and retry.'
      );
    }
    return (
      `Timed out after ${timeoutMs}ms: the Chrome extension is polling (last seen ` +
      `${Math.round(pollAgeMs / 1000)}s ago) but did not pick up this command in time. Retry; ` +
      "if it persists, reload 'Pi Chrome Connector' at chrome://extensions."
    );
  }

  async #sendViaOwner(action, params, timeoutMs, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 2_000);
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    try {
      const response = await fetch(`${this.url}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, params, timeoutMs }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 404) {
        throw new Error(
          'A running session owns the Chrome bridge but speaks an older protocol without ' +
            'multi-session support. Restart that session, then retry.',
        );
      }
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Chrome bridge owner HTTP ${response.status}`);
      }
      return payload.result;
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (signal?.aborted) throw new Error('Chrome command aborted');
        throw new Error(`Timed out waiting ${timeoutMs}ms for Chrome action ${action}`);
      }
      // The owner vanished: grab the now-free port and run the command locally.
      if (isOwnerUnreachable(error)) {
        const promoted = await this.#tryPromoteToServer().catch(() => false);
        if (promoted) return this.#sendLocal(action, params, timeoutMs, signal);
        throw new Error(
          'The session that owned the Chrome bridge is unreachable and this session could not ' +
            'take over the bridge port. Restart this session, then retry.',
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  #enqueue(command) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(command);
    else this.#queue.push(command);
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? '/', this.url);
    const corsHeaders = corsHeadersFor(request);

    if (request.method === 'OPTIONS') {
      if (!isBrowserOriginAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'browser origin not allowed' });
        return;
      }
      sendJson(response, 200, { ok: true }, corsHeaders);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      sendJson(response, 200, this.status());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/command') {
      if (!isLocalProcessRequest(request)) {
        sendJson(
          response,
          403,
          { ok: false, error: 'Chrome commands are accepted only from local processes' },
        );
        return;
      }
      const body = JSON.parse(await readRequestBody(request));
      if (!body.action) {
        sendJson(response, 400, { ok: false, error: 'Missing command action' });
        return;
      }
      try {
        const result = await this.#sendLocal(
          body.action,
          body.params ?? {},
          body.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        sendJson(response, 200, { ok: true, result });
      } catch (error) {
        sendJson(response, 504, { ok: false, error: error?.message ?? String(error) });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/next') {
      if (!isBrowserOriginAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'browser origin not allowed' });
        return;
      }
      this.#lastSeenAt = Date.now();
      this.#clientName = url.searchParams.get('name') ?? undefined;

      let aborted = false;
      let activeWaiter;
      request.once('close', () => {
        aborted = true;
        if (activeWaiter) this.#waiters = this.#waiters.filter((entry) => entry !== activeWaiter);
      });

      let command = this.#queue.shift();
      if (!command) {
        command = await this.#waitForCommand(25_000, (waiter) => {
          activeWaiter = waiter;
        });
      }
      if (aborted) {
        // The long-poll died before delivery: requeue so the next poll picks it up.
        if (command) this.#queue.unshift(command);
        return;
      }
      if (command) {
        const entry = this.#pending.get(command.id);
        if (entry) entry.deliveredAt = Date.now();
      }
      sendJson(
        response,
        200,
        command ? { type: 'command', command } : { type: 'none' },
        corsHeaders,
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/result') {
      if (!isBrowserOriginAllowed(request)) {
        sendJson(response, 403, { ok: false, error: 'browser origin not allowed' });
        return;
      }
      this.#lastSeenAt = Date.now();
      const result = JSON.parse(await readRequestBody(request));
      const pending = this.#pending.get(result.id);
      if (!pending) {
        sendJson(response, 404, { ok: false, error: 'unknown command id' }, corsHeaders);
        return;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(result.id);
      if (result.ok) pending.resolve(result.result);
      else pending.reject(new Error(result.error ?? 'Chrome extension command failed'));
      sendJson(response, 200, { ok: true }, corsHeaders);
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  }

  #waitForCommand(timeoutMs, registerWaiter) {
    return new Promise((resolveWait) => {
      let settled = false;
      const waiter = (command) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters = this.#waiters.filter((entry) => entry !== waiter);
        resolveWait(command);
      };
      const timer = setTimeout(() => waiter(undefined), timeoutMs);
      this.#waiters.push(waiter);
      registerWaiter?.(waiter);
    });
  }
}
