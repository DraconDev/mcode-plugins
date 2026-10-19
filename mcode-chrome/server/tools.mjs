/**
 * The Chrome tool surface exposed over MCP.
 *
 * Every tool maps onto one action of the pi-chrome wire protocol, which the
 * companion extension executes inside the user's real, signed-in Chrome. The
 * tool names are intentionally short: the MCP server is named `chrome`, so the
 * model sees `mcp__chrome__click`, `mcp__chrome__snapshot`, and so on.
 *
 * Read-only tools (snapshot, find, inspect, console, network, tab list) never
 * need authorization. Everything that changes the page does.
 *
 * The definitions live as module-level data so `scripts/build-manifest.mjs` can
 * generate the plugin manifest from the same source the server uses — the
 * declared tool list can never drift from the implemented one.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import { DEFAULT_TIMEOUT_MS } from './bridge.mjs';
import { assertAuthorized, authStatus, authorize, revoke } from './auth.mjs';
import {
  formatInspect,
  formatSnapshot,
  formatTabs,
  redactJson,
  safeJson,
  summarizeActionResult,
  truncateText,
} from './format.mjs';

const MAX_ELEMENTS = 60;
const EVALUATE_OUTPUT_CAP = 20_000;

/** Target selection: pick one tab, or let the extension use this session's tab. */
const TARGET_PROPS = {
  targetId: {
    type: 'string',
    description:
      'Chrome tab id. Unstable across reloads — prefer urlIncludes/titleIncludes when you can.',
  },
  urlIncludes: {
    type: 'string',
    description: 'Match the target tab by URL substring.',
  },
  titleIncludes: {
    type: 'string',
    description: 'Match the target tab by title substring.',
  },
};

const BACKGROUND_PROP = {
  background: {
    type: 'boolean',
    description:
      'If true (the default) run silently without focusing Chrome. Pass false to focus Chrome and activate the tab so the user can watch.',
    default: true,
  },
};

const TARGET_SCHEMA = {
  type: 'object',
  properties: { ...TARGET_PROPS, ...BACKGROUND_PROP },
  additionalProperties: false,
};

/**
 * Base directory for relative filesystem paths.
 *
 * Defaults to the agent workspace. Absolute paths bypass it entirely.
 */
const BASE_DIR_PROP = {
  baseDir: {
    type: 'string',
    description:
      'Directory relative paths resolve against. Defaults to the agent workspace ' +
      '(the directory mcode was launched from).',
  },
};

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] };
}

function toolError(error) {
  return {
    content: [{ type: 'text', text: `ERROR: ${error?.message ?? String(error)}` }],
    isError: true,
  };
}

/**
 * Build the wire params for an action: session scoping, the session tab group,
 * and the background/foreground translation the companion expects.
 */
function wireParams(action, args, session) {
  const params = { ...args };
  params.sessionKey = session.sessionKey;

  // Tabs this session opens belong to this session's group.
  if (action === 'tab.new' || action === 'tab.group') {
    params.groupTitle = session.groupTitle;
  }
  // Tabs this session *drives* are pulled into the same group, so the user can
  // see exactly which tabs the agent is working in.
  if (action.startsWith('page.') && !params.sessionGroupTitle) {
    params.sessionGroupTitle = session.groupTitle;
    params.joinSessionGroup = true;
  }
  return params;
}

/** The public `background` flag (default: silent) becomes the wire `foreground` flag. */
function withBackground(params) {
  const { background, foreground, ...rest } = params;
  const explicit =
    background !== undefined ? background : foreground !== undefined ? !foreground : undefined;
  const silent = explicit ?? true;
  return { ...rest, foreground: !silent };
}

/**
 * @typedef {object} ToolContext
 * @property {import('./bridge.mjs').ChromeBridge} bridge
 * @property {{ sessionKey: string, groupTitle: string }} session
 * @property {string} extensionPath
 * @property {string} workspaceCwd
 */

/** @type {{ name: string, description: string, inputSchema: object, run: (args: any, ctx: ToolContext) => Promise<any> }[]} */
const TOOL_DEFS = [
  {
    name: 'status',
    description:
      'Check the Chrome bridge: whether the companion extension is connected, whether Chrome control is authorized, and how to connect the extension if it is not. Start here before any other Chrome tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const status = await ctx.bridge.probeStatus();
      const auth = authStatus();
      const lines = [
        '# Chrome bridge status',
        `url: ${status.url}`,
        `mode: ${status.mode}${
          status.mode === 'client'
            ? ' (another session owns the port; commands are forwarded to it)'
            : ' (this session owns the port)'
        }`,
        `extension: ${status.connected ? 'connected' : 'not polling'}`,
      ];
      if (status.clientName) lines.push(`client: ${status.clientName}`);
      if (status.lastSeenAt) {
        lines.push(`last poll: ${Math.round((Date.now() - status.lastSeenAt) / 1000)}s ago`);
      }
      lines.push(
        `control: ${auth.authorized ? 'authorized' : 'LOCKED'}${
          auth.until && auth.until !== 'indefinite'
            ? ` (until ${new Date(auth.until).toISOString()})`
            : ''
        }`,
      );
      if (!auth.authorized) {
        lines.push('  Actuation tools are blocked. Ask the user to call `authorize` first.');
      }
      if (!status.connected) {
        lines.push('');
        lines.push('The companion extension is not polling. To connect:');
        lines.push('1. Open chrome://extensions in the Chrome profile you normally use.');
        lines.push('2. Enable Developer mode.');
        lines.push('3. Click "Load unpacked".');
        lines.push(`4. Select: ${ctx.extensionPath}`);
      }
      return text(lines.join('\n'));
    },
  },
  {
    name: 'authorize',
    description:
      'Unlock Chrome control so tools that change the page (navigate, click, type, fill, key, upload) can run. Call this only when the user asks for browser control.',
    inputSchema: {
      type: 'object',
      properties: {
        duration: {
          type: 'string',
          description:
            'How long the authorization lasts: "indefinite", or a number of minutes (e.g. "15"). Defaults to "indefinite".',
          default: 'indefinite',
        },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const raw = String(args?.duration ?? 'indefinite').trim().toLowerCase();
      const minutes = raw === 'indefinite' ? 'indefinite' : Number(raw);
      if (minutes !== 'indefinite' && (!Number.isFinite(minutes) || minutes <= 0)) {
        return toolError(
          new Error('duration must be "indefinite" or a positive number of minutes.'),
        );
      }
      const result = authorize(minutes);
      return text(
        `Chrome control authorized${
          result.until === 'indefinite' ? ' indefinitely' : ` for ${minutes} minute(s)`
        }.`,
      );
    },
  },
  {
    name: 'revoke',
    description:
      'Lock Chrome control. Read-only tools keep working; tools that change the page are blocked until the next `authorize`.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      revoke();
      return text('Chrome control locked. Read-only tools still work.');
    },
  },
  {
    name: 'tab',
    description:
      "List, open, activate, close, or group tabs in the user's real Chrome. Use action=list to see what is open. New tabs join this session's tab group.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'new', 'activate', 'close', 'group', 'ungroup', 'version'],
          description: 'The tab operation to perform.',
        },
        url: { type: 'string', description: 'URL to open (action=new).' },
        ...TARGET_PROPS,
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { background, ...rest } = args;
      const result = await ctx.send(`tab.${args.action}`, rest, { group: false });
      return text(args.action === 'list' ? formatTabs(result) : safeJson(result));
    },
  },
  {
    name: 'snapshot',
    description:
      "Observe the page in the user's real Chrome: structure, visible actions, form fields, page text, and what changed since the previous snapshot. Returns stable uids you can pass to click/type/fill. Use query or mode to zoom in instead of dumping the whole page.",
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
        maxElements: {
          type: 'number',
          description: 'Maximum elements to return.',
          default: MAX_ELEMENTS,
        },
        mode: {
          type: 'string',
          enum: ['auto', 'interactive', 'forms', 'pageMap', 'text', 'changes', 'full'],
          description: 'Which view of the page to return.',
        },
        query: {
          type: 'string',
          description:
            'Find and rank elements, regions, and text matching this phrase, e.g. "merge button", "email error", "approve PR".',
        },
        maxTextChars: { type: 'number', description: 'Max body text characters to include.' },
        containingText: {
          type: 'string',
          description: 'Only return elements whose label or text contains this string.',
        },
        roleFilter: {
          type: 'string',
          description:
            'Only return elements matching this ARIA role or tag name, e.g. "button", "link".',
        },
        nearUid: { type: 'string', description: 'Sort elements by proximity to this snapshot uid.' },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const snapshot = await ctx.pageSend('page.snapshot', {
        ...args,
        maxElements: args.maxElements ?? MAX_ELEMENTS,
      });
      return text(formatSnapshot(snapshot));
    },
  },
  {
    name: 'find',
    description:
      'Find elements, page regions, or text on the page by natural-language query. Returns ranked matches with stable uids and coordinates. A focused form of snapshot({ query }).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to find, e.g. "merge button", "search box".' },
        mode: {
          type: 'string',
          enum: ['auto', 'interactive', 'forms', 'pageMap', 'text', 'changes', 'full'],
        },
        maxElements: { type: 'number', default: MAX_ELEMENTS },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      required: ['query'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const snapshot = await ctx.pageSend('page.snapshot', {
        ...args,
        mode: args.mode || 'auto',
        maxElements: args.maxElements ?? MAX_ELEMENTS,
      });
      return text(formatSnapshot(snapshot));
    },
  },
  {
    name: 'inspect',
    description:
      'Inspect one snapshot uid or selector deeply: nearby text, nearby actions, form context, ancestors, and a suggested click target. Use after snapshot/find when you need context around one element.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Stable element uid from snapshot or find.' },
        selector: { type: 'string', description: 'CSS selector, if no uid is available.' },
        scrollIntoView: {
          type: 'boolean',
          description: 'Scroll the target into view before inspecting. Default false.',
        },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      try {
        const inspect = await ctx.pageSend('page.inspect', args);
        return text(formatInspect(inspect));
      } catch (error) {
        // Older companion builds do not implement page.inspect; fall back to a
        // targeted snapshot so the workflow still completes.
        if (!/Unknown action: page\.inspect/i.test(error?.message ?? '')) throw error;
        const snapshot = await ctx.pageSend('page.snapshot', {
          ...args,
          mode: 'interactive',
          maxElements: MAX_ELEMENTS,
          nearUid: args.uid,
          query: args.selector,
        });
        return text(
          'inspect fallback: the loaded Chrome extension does not support deep inspect yet. ' +
            "Reload 'Pi Chrome Connector' at chrome://extensions for the richer view.\n\n" +
            formatSnapshot(snapshot),
        );
      }
    },
  },
  {
    name: 'navigate',
    description:
      "Navigate a Chrome tab to a URL. With no target, this session's dedicated automation tab is used — your currently active tab is never replaced. Pass targetId/urlIncludes/titleIncludes to act on a specific existing tab.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to.' },
        waitUntilLoad: { type: 'boolean', description: 'Wait for the load event.', default: true },
        timeoutMs: { type: 'number', description: 'Navigation timeout in ms.', default: 15_000 },
        initScript: {
          type: 'string',
          description:
            'JavaScript to run in the page at document_start of the next navigation. Useful for seeding localStorage or stubbing Date.now().',
        },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      required: ['url'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const timeoutMs = args.timeoutMs ?? 15_000;
      const result = await ctx.pageSend('page.navigate', args, { timeoutMs: timeoutMs + 2_000 });
      return text(
        `Navigated to ${args.url}${args.initScript ? ' (with initScript)' : ''}\n${safeJson(result)}`,
      );
    },
  },
  {
    name: 'evaluate',
    description:
      "Evaluate JavaScript in the page (MAIN world, so it is not blocked by the page's CSP) and return a JSON-serializable value. Keep expressions read-only unless the user has authorized actuation.",
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate.' },
        awaitPromise: { type: 'boolean', description: 'Await a returned promise.', default: true },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      required: ['expression'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const value = await ctx.pageSend('page.evaluate', args);
      const rendered = typeof value === 'string' ? value : safeJson(value);
      return text(truncateText(rendered, EVALUATE_OUTPUT_CAP));
    },
  },
  {
    name: 'click',
    description:
      "Click an element by snapshot uid, CSS selector, or viewport coordinate using Chrome's real input layer. Prefer uid over selector after a snapshot.",
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Stable element uid from snapshot or find.' },
        selector: { type: 'string', description: 'CSS selector to click.' },
        x: { type: 'number', description: 'Viewport x coordinate, if no uid or selector.' },
        y: { type: 'number', description: 'Viewport y coordinate, if no uid or selector.' },
        includeSnapshot: { type: 'boolean', description: 'Return a fresh snapshot after the click.' },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const raw = await ctx.pageSend('page.click', args);
      const summary = summarizeActionResult(args.includeSnapshot ? raw?.result : raw);
      const target = args.uid ?? args.selector ?? `${args.x},${args.y}`;
      const base = summary ? `Clicked ${target} — ${summary}` : `Clicked ${target}`;
      return text(
        args.includeSnapshot ? `${base}\n\n${formatSnapshot(raw?.snapshot)}` : base,
      );
    },
  },
  {
    name: 'type',
    description:
      "Focus an optional snapshot uid or selector, then type text using Chrome's real keyboard input.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        uid: { type: 'string', description: 'Stable element uid to focus first.' },
        selector: { type: 'string', description: 'CSS selector to focus first.' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing.' },
        includeSnapshot: { type: 'boolean', description: 'Return a fresh snapshot after typing.' },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const raw = await ctx.pageSend('page.type', args);
      const summary = summarizeActionResult(args.includeSnapshot ? raw?.result : raw);
      const into = args.uid || args.selector ? ` into ${args.uid ?? args.selector}` : '';
      const base = `Typed ${args.text.length} character(s)${into}.`;
      const message = summary ? `${base} (${summary})` : base;
      return text(args.includeSnapshot ? `${message}\n\n${formatSnapshot(raw?.snapshot)}` : message);
    },
  },
  {
    name: 'fill',
    description:
      "Set the full value of a text input, textarea, or contenteditable element using Chrome click/select/delete/type input. Use this instead of type for form fields.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Value to set.' },
        uid: { type: 'string', description: 'Stable element uid from snapshot or find.' },
        selector: { type: 'string', description: 'CSS selector, if no uid.' },
        submit: { type: 'boolean', description: 'Press Enter after filling.' },
        includeSnapshot: { type: 'boolean', description: 'Return a fresh snapshot after filling.' },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const raw = await ctx.pageSend('page.fill', args);
      const summary = summarizeActionResult(args.includeSnapshot ? raw?.result : raw);
      const into = args.uid || args.selector ? ` into ${args.uid ?? args.selector}` : '';
      const base = `Filled ${args.text.length} character(s)${into}.`;
      const message = summary ? `${base} (${summary})` : base;
      return text(args.includeSnapshot ? `${message}\n\n${formatSnapshot(raw?.snapshot)}` : message);
    },
  },
  {
    name: 'key',
    description:
      'Send a keyboard key to the page: Enter, Escape, Tab, Backspace, Delete, Arrow keys, or a single character.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name or a single character.' },
        modifiers: {
          type: 'object',
          description: 'Modifier keys held while pressing the key.',
          properties: {
            shiftKey: { type: 'boolean' },
            ctrlKey: { type: 'boolean' },
            altKey: { type: 'boolean' },
            metaKey: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        includeSnapshot: { type: 'boolean', description: 'Return a fresh snapshot after the keypress.' },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      required: ['key'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const raw = await ctx.pageSend('page.key', args);
      const base = `Pressed ${args.key}.`;
      return text(args.includeSnapshot ? `${base}\n\n${formatSnapshot(raw?.snapshot)}` : base);
    },
  },
  {
    name: 'wait_for',
    description:
      'Wait until a CSS selector exists on the page, or until a JavaScript expression returns truthy.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['selector', 'expression'], description: 'What to wait for.' },
        value: { type: 'string', description: 'CSS selector, or JavaScript expression.' },
        timeoutMs: { type: 'number', description: 'How long to wait, in ms.', default: 10_000 },
        intervalMs: { type: 'number', description: 'Polling interval in ms.', default: 250 },
        ...TARGET_PROPS,
      },
      required: ['kind', 'value'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const timeoutMs = args.timeoutMs ?? 10_000;
      const result = await ctx.send('page.waitFor', args, {
        timeoutMs: timeoutMs + 2_000,
        group: false,
      });
      return text(`Observed ${args.kind}: ${args.value}\n${safeJson(result)}`);
    },
  },
  {
    name: 'console_messages',
    description:
      'List console messages captured in the page. Capture starts after a snapshot, evaluate, console, or network call installs the page instrumentation.',
    inputSchema: {
      ...TARGET_SCHEMA,
      properties: {
        ...TARGET_SCHEMA.properties,
        clear: { type: 'boolean', description: 'Clear the captured log after reading.' },
      },
    },
    run: async (args, ctx) => {
      const result = await ctx.pageSend('page.console.list', args);
      return text(truncateText(redactJson(result)));
    },
  },
  {
    name: 'network_requests',
    description:
      'List fetch/XHR activity captured in the page. Browser document and static-asset requests are not captured.',
    inputSchema: {
      ...TARGET_SCHEMA,
      properties: {
        ...TARGET_SCHEMA.properties,
        includePreservedRequests: {
          type: 'boolean',
          description: 'Include requests captured before earlier navigations in the same tab.',
        },
        clear: { type: 'boolean', description: 'Clear the captured log after reading.' },
      },
    },
    run: async (args, ctx) => {
      const result = await ctx.pageSend('page.network.list', args);
      return text(truncateText(redactJson(result)));
    },
  },
  {
    name: 'network_request',
    description:
      'Retrieve one captured request by id, including the response body when the extension captured it.',
    inputSchema: {
      ...TARGET_SCHEMA,
      properties: {
        ...TARGET_SCHEMA.properties,
        requestId: { type: 'string', description: 'Request id from network_requests.' },
      },
      required: ['requestId'],
    },
    run: async (args, ctx) => {
      const result = await ctx.pageSend('page.network.get', args);
      return text(truncateText(redactJson(result)));
    },
  },
  {
    name: 'screenshot',
    description:
      "Capture a screenshot of the page in the user's real Chrome. The image is returned inline; pass path to also save it to disk.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional path to also write the image to. A relative path resolves against the ' +
            'agent workspace; an absolute path is unambiguous and preferred.',
        },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format.', default: 'png' },
        quality: { type: 'number', description: 'JPEG quality, 0-100.' },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page as stitched tiles.',
        },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
        ...BASE_DIR_PROP,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const result = await ctx.pageSend('page.screenshot', args, {
        timeoutMs: args.fullPage ? 120_000 : DEFAULT_TIMEOUT_MS,
      });

      const blocks = [];
      if (result?.fullPage && Array.isArray(result.tiles) && result.dimensions) {
        for (const tile of result.tiles) {
          const base64 = String(tile.dataUrl ?? '').replace(
            /^data:image\/(?:png|jpeg);base64,/,
            '',
          );
          if (base64) {
            blocks.push({
              type: 'image',
              data: base64,
              mimeType: args.format === 'jpeg' ? 'image/jpeg' : 'image/png',
            });
          }
        }
        if (args.path) {
          const target = resolve(args.baseDir ?? ctx.workspaceCwd, args.path);
          await mkdir(dirname(target), { recursive: true });
          const first = String(result.tiles[0]?.dataUrl ?? '').replace(
            /^data:image\/(?:png|jpeg);base64,/,
            '',
          );
          await writeFile(target, Buffer.from(first, 'base64'));
        }
        blocks.push({
          type: 'text',
          text: `Full-page capture: ${result.dimensions.width}x${result.dimensions.height}px in ${result.tiles.length} tile(s).`,
        });
        return { content: blocks };
      }

      const dataUrl = String(result?.dataUrl ?? '');
      const base64 = dataUrl.replace(/^data:image\/(?:png|jpeg);base64,/, '');
      if (!base64) return toolError(new Error('Screenshot returned no dataUrl.'));
      if (args.path) {
        const target = resolve(args.baseDir ?? ctx.workspaceCwd, args.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(base64, 'base64'));
      }
      blocks.push({
        type: 'image',
        data: base64,
        mimeType: args.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      });
      blocks.push({
        type: 'text',
        text: args.path
          ? `Saved to ${resolve(args.baseDir ?? ctx.workspaceCwd, args.path)}.`
          : 'Screenshot captured.',
      });
      return { content: blocks };
    },
  },
  {
    name: 'hover',
    description:
      'Hover over an element by uid, selector, or coordinate to trigger :hover and mouseover handlers.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      await ctx.pageSend('page.hover', args);
      return text(`Hovered ${args.uid ?? args.selector ?? `${args.x},${args.y}`}`);
    },
  },
  {
    name: 'drag',
    description: 'Drag from one element or point to another using Chrome pointer input.',
    inputSchema: {
      type: 'object',
      properties: {
        fromUid: { type: 'string' },
        fromSelector: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toUid: { type: 'string' },
        toSelector: { type: 'string' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        steps: { type: 'number', description: 'Number of pointer steps.', default: 12 },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      await ctx.pageSend('page.drag', args);
      return text(
        `Dragged from ${args.fromUid ?? args.fromSelector} to ${args.toUid ?? args.toSelector}`,
      );
    },
  },
  {
    name: 'tap',
    description:
      'Dispatch a real touch tap for sites that gate on TouchEvent rather than MouseEvent (mobile-first PWAs, swipe carousels).',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string' },
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      await ctx.pageSend('page.tap', args);
      return text(`Tapped ${args.uid ?? args.selector ?? `${args.x},${args.y}`} (touch)`);
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page or a scrollable element with real wheel events. Positive deltaY scrolls down.',
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string', description: 'Scroll within this element instead of the document.' },
        selector: { type: 'string' },
        deltaY: { type: 'number', description: 'Pixels to scroll vertically. Positive = down.' },
        deltaX: { type: 'number', description: 'Pixels to scroll horizontally. Positive = right.' },
        steps: { type: 'number', description: 'Number of wheel events.' },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      await ctx.pageSend('page.scroll', args);
      return text(`Scrolled dy=${args.deltaY ?? 0} dx=${args.deltaX ?? 0}`);
    },
  },
  {
    name: 'upload_file',
    description:
      "Attach local files to an <input type=file> element using Chrome DevTools file-input control. Does not open the native file picker.",
    inputSchema: {
      type: 'object',
      properties: {
        uid: { type: 'string' },
        selector: { type: 'string' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Local file paths to upload. Relative paths resolve against the agent workspace; ' +
            'absolute paths are unambiguous and preferred.',
        },
        ...TARGET_PROPS,
        ...BACKGROUND_PROP,
        ...BASE_DIR_PROP,
      },
      required: ['paths'],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const base = args.baseDir ?? ctx.workspaceCwd;
      const paths = (args.paths ?? []).map((p) => resolve(base, p));
      await ctx.pageSend('page.upload', { ...args, paths });
      return text(`Uploaded ${paths.length} file(s) to ${args.uid ?? args.selector}`);
    },
  },
];

/** Tool schemas for the plugin manifest — same source as the implementation. */
export const TOOL_SCHEMAS = TOOL_DEFS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

/**
 * @param {object} options
 * @param {import('./bridge.mjs').ChromeBridge} options.bridge
 * @param {{ sessionKey: string, groupTitle: string }} options.session
 * @param {string} options.extensionPath
 * @param {string} options.workspaceCwd
 */
export function createTools({ bridge, session, extensionPath, workspaceCwd }) {
  const send = async (action, args = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, group = true } = {}) => {
    assertAuthorized(action);
    const params = group
      ? wireParams(action, args, session)
      : { ...args, sessionKey: session.sessionKey };
    return bridge.send(action, params, timeoutMs);
  };

  const ctx = {
    bridge,
    session,
    extensionPath,
    workspaceCwd,
    send,
    pageSend: (action, args = {}, options = {}) =>
      send(action, withBackground(args), options),
  };

  return TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: (args) => def.run(args, ctx),
  }));
}
