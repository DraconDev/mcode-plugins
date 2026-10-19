/**
 * Output shaping for browser results.
 *
 * A signed-in browser is full of credentials, so anything printed here is
 * redacted first: secret-shaped keys lose their values, data URLs are elided,
 * and long strings are truncated. Page content still reaches the model, exactly
 * as it does in pi-chrome — the skill tells the agent to say so when the page is
 * sensitive.
 */

const SECRET_KEY =
  /(api[_-]?key|apikey|token|secret|password|passwd|pwd|auth|bearer|session|cookie|set-cookie|authorization|x-api-key|private[_-]?key|client[_-]?secret|vault)/i;

/**
 * The key under which the companion extension stores a raw header block
 * (`XMLHttpRequest.getAllResponseHeaders()`), e.g. "x-csrf-token: …\r\n".
 */
const HEADER_BLOCK_KEY = 'responseHeadersText';

const MAX_TEXT = 20_000;

export function compactLine(value, max = 120) {
  if (value === undefined || value === null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function truncateText(text, max = MAX_TEXT) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function secretLength(value) {
  if (typeof value === 'string') return `${value.length} chars`;
  if (value === null || value === undefined) return 'empty';
  return typeof value;
}

/**
 * Is this a `[name, value]` header pair?
 *
 * `Headers.entries()` yields exactly that shape, so a fetch response stores
 * its headers as an array of pairs rather than as an object with keys.
 */
function isHeaderPair(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

/** Redact a `[name, value]` header pair by its name. */
function redactHeaderPair(pair, depth) {
  const [name, value] = pair;
  if (SECRET_KEY.test(name)) return [name, `[REDACTED ${secretLength(value)}]`];
  return [name, redact(value, depth + 1)];
}

/**
 * Redact one raw header block, e.g. "content-type: text/html\r\nx-csrf-token: …".
 *
 * The block is split on CRLF first so every header can be matched by its own
 * name — the block itself has no secret-shaped key to match on.
 */
function redactHeaderBlock(text) {
  const separator = text.includes('\r\n') ? '\r\n' : '\n';
  return text
    .split(/\r\n|\n/)
    .map((line) => {
      const colon = line.indexOf(':');
      if (colon < 0) return line;
      const name = line.slice(0, colon).trim();
      if (!name || !SECRET_KEY.test(name)) return line;
      const value = line.slice(colon + 1).trim();
      return `${line.slice(0, colon + 1)} [REDACTED ${secretLength(value)}]`;
    })
    .join(separator);
}

/**
 * Redact secret-shaped values before anything is printed.
 *
 * The companion extension stores response headers in three different shapes,
 * and only one of them has secret-shaped *keys*:
 *   - fetch:  [["x-api-key", "sk-live-…"], …]   (Headers.entries())
 *   - XHR:    "x-api-key: sk-live-…\r\n…"        (getAllResponseHeaders())
 *   - object: {"x-api-key": "sk-live-…"}
 * The first two carry no key to match on, so they are normalised into
 * name/value pairs before the secret check runs.
 */
export function redact(value, depth = 0) {
  if (depth > 12) return '[TRUNCATED-DEPTH]';
  if (typeof value === 'string') {
    if (value.startsWith('data:')) {
      const comma = value.indexOf(',');
      const head = comma > 0 ? value.slice(0, Math.min(comma, 64)) : 'data:';
      return `[DATA-URL ${head}... ${value.length} chars]`;
    }
    if (value.length > 2000) return `${value.slice(0, 2000)}…[TRUNCATED ${value.length} chars]`;
    return value;
  }
  if (Array.isArray(value)) {
    if (isHeaderPair(value)) return redactHeaderPair(value, depth);
    return value.map((entry) => redact(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    // A null-prototype object: assigning `__proto__` on a plain object hits
    // the inherited prototype setter, which silently drops the entry.
    const out = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (key === HEADER_BLOCK_KEY && typeof entry === 'string') {
        out[key] = redactHeaderBlock(entry);
        continue;
      }
      out[key] = SECRET_KEY.test(key)
        ? `[REDACTED ${secretLength(entry)}]`
        : redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactJson(value) {
  return safeJson(redact(value));
}

function rectText(rect) {
  if (!rect || typeof rect !== 'object') return '';
  const { x, y, width, height } = rect;
  if ([x, y, width, height].some((part) => typeof part !== 'number')) return '';
  return `${x},${y} ${width}x${height}`;
}

/**
 * Render one entry of the companion's snapshot diff.
 *
 * `diffSnapshot()` returns objects (`{kind:'url',before,after}`,
 * `{kind:'textChanged'}`, …), so a plain template string would print
 * "[object Object]".
 */
function formatChange(change) {
  if (!change || typeof change !== 'object') return compactLine(change, 80);
  const kind = change.kind ?? 'change';
  if (change.before === undefined && change.after === undefined) return kind;
  const before =
    change.before === undefined || change.before === null
      ? '(none)'
      : compactLine(change.before, 80);
  const after =
    change.after === undefined || change.after === null ? '(none)' : compactLine(change.after, 80);
  return `${kind}: ${before} → ${after}`;
}

/**
 * Render an accessibility snapshot as a compact, agent-friendly report: page
 * identity, layout, forms, visible actions, text snippets, and what changed
 * since the previous snapshot. `mode`/`query` are there to zoom in instead of
 * dumping the whole page.
 */
export function formatSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return safeJson(snapshot);
  const lines = [];

  lines.push(`# ${snapshot.title || '(untitled page)'}`);
  lines.push(snapshot.url || '');
  if (snapshot.mode) lines.push(`mode: ${snapshot.mode}`);

  // The extension reports changes under `snapshot.diff` — `diffSnapshot()`
  // returns { changes, added, removed, updated }. There is no top-level
  // `changes` key, so reading that would leave this section permanently empty.
  const diff = snapshot.diff ?? null;
  const changes = Array.isArray(diff?.changes) ? diff.changes : [];
  if (changes.length || diff?.firstSnapshot) {
    lines.push('\n## Changed since last snapshot');
    if (diff.firstSnapshot) lines.push('- first snapshot: nothing to compare against yet');
    for (const item of changes.slice(0, 10)) lines.push(`- ${formatChange(item)}`);
    const added = diff.added?.length ?? 0;
    const removed = diff.removed?.length ?? 0;
    const updated = diff.updated?.length ?? 0;
    if (added || removed || updated) {
      lines.push(`- elements: ${added} added, ${removed} removed, ${updated} updated`);
    }
  }

  if (Array.isArray(snapshot.matches) && snapshot.matches.length) {
    lines.push(`\n## Matches for "${snapshot.query}"`);
    for (const match of snapshot.matches.slice(0, 12)) {
      if (match.kind === 'text') {
        lines.push(`- ${match.uid} text ${compactLine(match.text)} @ ${rectText(match.rect)}`);
      } else if (match.kind === 'region') {
        const headings = (match.headings || []).map((h) => compactLine(h, 50)).join(' | ');
        lines.push(`- ${match.uid} region ${compactLine(match.label)} headings=${headings}`);
      } else {
        lines.push(
          `- ${match.uid} ${match.role || match.tag || 'element'}${match.disabled ? ' disabled' : ''} ` +
            `${compactLine(match.label || match.selector)} @ ${rectText(match.rect)}`,
        );
      }
    }
  }

  if (snapshot.mode === 'pageMap' && snapshot.pageMap) {
    lines.push('\n## Page map');
    for (const region of (snapshot.pageMap.regions || []).slice(0, 18)) {
      lines.push(`- ${region.uid} ${region.kind}: ${compactLine(region.label)}`);
      for (const action of (region.actions || []).slice(0, 5)) {
        lines.push(`  - ${action.uid} ${action.role || ''}${action.disabled ? ' disabled' : ''} ${compactLine(action.label)}`);
      }
    }
    if (snapshot.pageMap.headings?.length) {
      lines.push('\nHeadings:');
      for (const heading of snapshot.pageMap.headings.slice(0, 20)) {
        lines.push(`- ${heading.uid} h${heading.level || ''} ${compactLine(heading.text)}`);
      }
    }
  }

  if (Array.isArray(snapshot.layout) && snapshot.layout.length && snapshot.mode !== 'changes') {
    lines.push('\n## Layout / context');
    const limit = snapshot.mode === 'pageMap' ? 18 : 8;
    for (const section of snapshot.layout.slice(0, limit)) {
      const bits = [
        section.uid,
        section.role || section.tag,
        compactLine(section.label || section.text || '(unnamed section)', 110),
        `@ ${rectText(section.rect)}`,
      ];
      lines.push(`- ${bits.filter(Boolean).join(' ')}`);
      const fields = (section.fields || [])
        .slice(0, 4)
        .map((f) => `${f.uid} ${compactLine(f.label || f.role, 40)}`);
      const actions = (section.actions || [])
        .slice(0, 5)
        .map((a) => `${a.uid}${a.disabled ? ' disabled' : ''} ${compactLine(a.label || a.role, 40)}`);
      if (fields.length) lines.push(`  fields: ${fields.join('; ')}`);
      if (actions.length) lines.push(`  actions: ${actions.join('; ')}`);
    }
  }

  if ((snapshot.mode === 'forms' || snapshot.forms?.fields?.length) && snapshot.mode !== 'pageMap') {
    const fields = snapshot.forms?.fields || [];
    const submits = snapshot.forms?.submits || [];
    if (fields.length || submits.length) lines.push('\n## Forms');
    for (const field of fields.slice(0, snapshot.mode === 'forms' ? 40 : 12)) {
      const bits = [
        field.uid,
        field.role || field.tag,
        field.required ? 'required' : '',
        field.invalid ? 'invalid' : '',
        field.disabled ? 'disabled' : '',
        compactLine(field.label || field.selector, 90),
      ];
      if (field.value) bits.push(`value=${compactLine(field.value, 50)}`);
      else if (field.valueRedacted) bits.push('value=[redacted]');
      lines.push(`- ${bits.filter(Boolean).join(' ')} @ ${rectText(field.rect)}`);
    }
    for (const submit of submits.slice(0, 8)) {
      lines.push(
        `- ${submit.uid} submit/action${submit.disabled ? ' disabled' : ''} ` +
          `${compactLine(submit.label || submit.selector)} @ ${rectText(submit.rect)}`,
      );
    }
  }

  if (Array.isArray(snapshot.elements) && snapshot.mode !== 'pageMap') {
    lines.push('\n## Visible actions');
    const limit = snapshot.mode === 'interactive' ? 60 : 25;
    for (const el of snapshot.elements.slice(0, limit)) {
      const flags = [el.disabled ? 'disabled' : '', el.occluded ? `occluded-by-${el.occluded.tag}` : '']
        .filter(Boolean)
        .join(',');
      const context = el.context?.label ? ` in ${el.context.uid} ${compactLine(el.context.label, 60)}` : '';
      lines.push(
        `- ${el.uid} ${el.role || el.tag}${flags ? ` [${flags}]` : ''} ` +
          `${compactLine(el.label || el.selector)}${context} @ ${rectText(el.rect)}`,
      );
    }
    if (snapshot.elements.length > limit) {
      lines.push(`- … ${snapshot.elements.length - limit} more; retry with maxElements or mode=interactive`);
    }
  }

  if (
    (snapshot.mode === 'text' || snapshot.mode === 'auto') &&
    Array.isArray(snapshot.textSnippets) &&
    snapshot.textSnippets.length
  ) {
    lines.push('\n## Text snippets');
    for (const snippet of snapshot.textSnippets.slice(0, snapshot.mode === 'text' ? 40 : 14)) {
      lines.push(`- ${snippet.uid} ${compactLine(snippet.text, snapshot.mode === 'text' ? 240 : 160)}`);
    }
    if (snapshot.textTruncated) {
      lines.push('- … page text truncated; retry with mode=text or maxTextChars for more');
    }
  }

  lines.push(
    "\nTip: use snapshot({ query: '...', mode: 'interactive|forms|pageMap|text|changes|full' }) or nearUid to zoom in.",
  );
  return truncateText(lines.join('\n'));
}

/** Render a deep inspect of one element. */
export function formatInspect(inspect) {
  if (!inspect || typeof inspect !== 'object') return safeJson(inspect);
  const target = inspect.target || {};
  const lines = [];
  lines.push(`# Chrome inspect ${target.uid || ''}`.trim());
  lines.push(
    `${target.role || target.tag || 'element'}${target.disabled ? ' disabled' : ''}` +
      `${target.occluded ? ` occluded-by-${target.occluded.tag}` : ''} ` +
      `${compactLine(target.label || target.selector)}`,
  );
  if (target.selector) lines.push(`selector: ${target.selector}`);
  if (target.rect) lines.push(`rect: ${rectText(target.rect)}`);
  if (inspect.clickSuggestion) {
    lines.push(
      `suggested click: click({ uid: "${inspect.clickSuggestion.uid}" }) or ` +
        `x=${inspect.clickSuggestion.x}, y=${inspect.clickSuggestion.y}`,
    );
  }
  if (Array.isArray(inspect.nearbyText) && inspect.nearbyText.length) {
    lines.push('\n## Nearby text');
    for (const item of inspect.nearbyText.slice(0, 12)) {
      lines.push(`- ${item.uid} ${compactLine(item.text, 180)}`);
    }
  }
  if (inspect.formContext) {
    lines.push('\n## Form context');
    for (const field of (inspect.formContext.fields || []).slice(0, 20)) {
      lines.push(
        `- ${field.uid} ${field.role || field.tag}${field.disabled ? ' disabled' : ''} ` +
          `${compactLine(field.label || field.selector)}` +
          `${field.value ? ` value=${compactLine(field.value, 60)}` : field.valueRedacted ? ' value=[redacted]' : ''}`,
      );
    }
    for (const action of (inspect.formContext.actions || []).slice(0, 10)) {
      lines.push(
        `- ${action.uid} action${action.disabled ? ' disabled' : ''} ${compactLine(action.label || action.selector)}`,
      );
    }
  }
  if (Array.isArray(inspect.nearbyActions) && inspect.nearbyActions.length) {
    lines.push('\n## Nearby actions');
    for (const action of inspect.nearbyActions.slice(0, 18)) {
      lines.push(
        `- ${action.uid} ${action.role || action.tag}${action.disabled ? ' disabled' : ''} ` +
          `${compactLine(action.label || action.selector)} @ ${rectText(action.rect)}`,
      );
    }
  }
  if (Array.isArray(inspect.ancestors) && inspect.ancestors.length) {
    lines.push('\n## Ancestors');
    for (const ancestor of inspect.ancestors.slice(0, 6)) {
      lines.push(
        `- ${ancestor.uid} ${ancestor.role || ancestor.tag} ${compactLine(ancestor.label || ancestor.selector, 120)}`,
      );
    }
  }
  return truncateText(lines.join('\n'));
}

/** Render a tab list as a compact table. */
export function formatTabs(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) return 'No tabs.';
  return (
    tabs
      .map(
        (tab) =>
          `${tab.id}\t${tab.active ? '*' : ' '}\t${tab.group?.title ? `[${tab.group.title}] ` : ''}` +
          `${tab.title || '(untitled)'}\t${tab.url}`,
      )
      .join('\n') || 'No tabs.'
  );
}

/** One-line summary of an actuation result, when the companion provides one. */
export function summarizeActionResult(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  if (result.clickable === false) parts.push('element was not clickable');
  if (result.occludedBy) parts.push(`occluded by <${result.occludedBy.tag ?? '?'}>`);
  if (result.valueMatches === false) parts.push('input value did not stick');
  if (result.autoplayHint) parts.push('autoplay-gated affordance');
  return parts.length ? parts.join('; ') : '';
}
