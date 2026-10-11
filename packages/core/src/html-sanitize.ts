/**
 * Dependency-free allowlist sanitizer for operator-authored rich text
 * (Activity.description_html and Package.description_html).
 *
 * The description is written by staff with `activity:write`, stored verbatim, and
 * then injected via `dangerouslySetInnerHTML` onto the PUBLIC booking page, the
 * availability detail, and a widget EMBEDDED on third-party sites — all of which
 * are reachable with no auth. Storing it unsanitized let a staffer (or a
 * compromised tenant) plant `<img src=x onerror=…>` / `<script>` and run script in
 * every anonymous visitor's browser, cross-tenant on any host embedding the widget.
 *
 * So the rule here is an ALLOWLIST, not a blocklist: anything not explicitly named
 * is dropped. That is the only form of HTML sanitization that is safe to hand-roll
 * — a blocklist of "bad" tags/attributes always loses to the next encoding trick.
 * We keep it in @marina/core (no DOM, no deps) because the same function has to run
 * server-side on write (the Zod schema), in the API response, and at render time in
 * both the web app and the admin, and core is the one place all of them import.
 *
 * What survives: a small set of formatting tags, and `href` on `<a>` only when the
 * URL is a safe scheme. Everything else — unknown tags, ALL attributes other than a
 * vetted `href`, every `on*` handler, `javascript:`/`data:`/`vbscript:` URLs,
 * comments, and raw `<script>`/`<style>` bodies — is removed. The output is only
 * ever a strict subset of safe markup, never executable.
 */

/** Tags allowed to pass through. Everything else is stripped (content kept). */
const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'span',
  'div',
]);

/**
 * Tags whose entire contents are discarded along with the tag — their text is
 * script/style source, not prose, so keeping the inner text would be wrong.
 */
const VOID_CONTENT_TAGS = new Set(['script', 'style', 'title', 'textarea', 'noscript']);

/** Self-closing/void elements that never have a closing tag. */
const SELF_CLOSING = new Set(['br']);

/**
 * Decode just enough HTML entities to inspect a URL scheme safely. An attacker can
 * write `java&#115;cript:` or `java&Tab;script:`; we strip character references and
 * control/whitespace before testing the scheme so those tricks resolve to the real
 * scheme they encode.
 */
function normalizeForSchemeCheck(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-z]+;?/gi, (m) => NAMED_ENTITIES[m.toLowerCase()] ?? '')
    // Drop ALL control chars and whitespace — `java\tscript:` and `  javascript:`
    // are both "javascript:" to a browser.
    .replace(/[\u0000-\u0020\u007f-\u00a0]/g, '')
    .toLowerCase();
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  '&colon;': ':',
  '&tab;': '\t',
  '&newline;': '\n',
  '&amp;': '&',
};

/** Is this `href` value a scheme we are willing to emit? */
function isSafeHref(raw: string): boolean {
  const v = normalizeForSchemeCheck(raw);
  if (v === '') return false;
  // A relative URL, fragment, or query has no scheme before the first ':' (or has no
  // colon at all) — those are safe. A scheme is present only when a colon appears
  // before any '/', '?' or '#'.
  const colon = v.indexOf(':');
  if (colon === -1) return true;
  const slash = v.indexOf('/');
  const q = v.indexOf('?');
  const hash = v.indexOf('#');
  const firstDelim = Math.min(
    ...[slash, q, hash].filter((i) => i !== -1).concat(Number.MAX_SAFE_INTEGER),
  );
  if (colon > firstDelim) return true; // colon is inside a path/query/fragment
  const scheme = v.slice(0, colon);
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
}

/** Escape a raw text run for safe emission as HTML text content. */
function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape an attribute value for emission inside double quotes. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pull the `href` value out of a raw start-tag's attribute string, if present. */
function extractHref(attrString: string): string | null {
  // href = "…" | '…' | bareword. Case-insensitive, whitespace-tolerant.
  const m = attrString.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}

/**
 * Sanitize operator-authored description HTML down to a safe allowlisted subset.
 *
 * Tokenizes into tags and text. Unknown tags are dropped but their text content is
 * kept (so a stray `<marquee>` just loses the tag). Allowlisted tags are re-emitted
 * with every attribute stripped, except a scheme-checked `href` on `<a>`. Script-ish
 * elements have their contents discarded entirely. The result is always a strict
 * subset of the input's visible prose with no executable surface.
 */
export function sanitizeHtml(input: string): string {
  if (!input) return '';

  let out = '';
  let i = 0;
  const n = input.length;
  // When >0 we are inside a dropped script/style element and must swallow text until
  // its matching close tag; tracks the tag name we are swallowing.
  let swallowUntil: string | null = null;

  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      if (!swallowUntil) out += escapeText(input.slice(i));
      break;
    }

    if (lt > i) {
      const text = input.slice(i, lt);
      if (!swallowUntil) out += escapeText(text);
    }

    // A '<' is only a markup start if the next char could begin a tag name, a close
    // tag, a comment or a declaration. `5 < 10` and `a < b` are prose — emit the '<'
    // as escaped text and move on, exactly as an HTML parser treats them.
    const next = input[lt + 1];
    if (next === undefined || !/[a-zA-Z/!?]/.test(next)) {
      if (!swallowUntil) out += '&lt;';
      i = lt + 1;
      continue;
    }

    // Comment / CDATA / doctype: drop wholesale.
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (input.startsWith('<!', lt) || input.startsWith('<?', lt)) {
      const end = input.indexOf('>', lt + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) {
      // Unterminated '<': treat the rest as text so nothing is silently executable.
      if (!swallowUntil) out += escapeText(input.slice(lt));
      break;
    }

    const rawTag = input.slice(lt + 1, gt);
    const isClose = rawTag.startsWith('/');
    const nameMatch = (isClose ? rawTag.slice(1) : rawTag).match(/^\s*([a-zA-Z][a-zA-Z0-9]*)/);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    i = gt + 1;

    if (!name) continue; // malformed, e.g. "< >"

    // Inside a script/style block: only its own close tag ends the swallow.
    if (swallowUntil) {
      if (isClose && name === swallowUntil) swallowUntil = null;
      continue;
    }

    if (VOID_CONTENT_TAGS.has(name)) {
      if (!isClose) swallowUntil = name;
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) continue; // drop unknown tag, keep its text

    if (isClose) {
      if (!SELF_CLOSING.has(name)) out += `</${name}>`;
      continue;
    }

    // Allowed open tag. Strip every attribute except a vetted href on <a>.
    const attrString = rawTag.slice(nameMatch!.index! + nameMatch![1].length);
    if (name === 'a') {
      const href = extractHref(attrString);
      if (href != null && isSafeHref(href)) {
        out += `<a href="${escapeAttr(href.trim())}" rel="nofollow noopener noreferrer">`;
      } else {
        out += '<a>';
      }
    } else if (SELF_CLOSING.has(name)) {
      out += `<${name}>`;
    } else {
      out += `<${name}>`;
    }
  }

  return out;
}

/**
 * Sanitize a nullable/optional description field. Returns `undefined` for nullish
 * input so it threads cleanly through the activity schema's optional column.
 */
export function sanitizeDescriptionHtml(input: string | null | undefined): string | undefined {
  if (input == null) return undefined;
  return sanitizeHtml(input);
}
