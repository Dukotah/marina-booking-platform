/**
 * Render-boundary safety net for rendered email bodies.
 *
 * WHY THIS EXISTS
 * ---------------
 * React 18's Node stream writer emits stray NUL bytes. In react-dom 18.3.1
 * (`cjs/react-dom-server.node.*.js`, `writeStringChunk`) output is encoded into a
 * fixed 2048-byte `currentView`. When the next character is multi-byte and does
 * not fit in the bytes left over, `TextEncoder.encodeInto` stops early and React
 * flushes the WHOLE view rather than the part it filled:
 *
 *     if (read < stringChunk.length) {
 *       writeToDestination(destination, currentView);  // not subarray(0, writtenBytes)
 *
 * The one to three trailing bytes it never filled are still zero, so they reach the
 * caller as literal U+0000 inside the HTML string.
 *
 * Every template here wraps in <BrandLayout>, which renders react-email's
 * <Preview>. <Preview> pads the inbox preview line with `150 - text.length`
 * repetitions of the seven-character run U+00A0 U+200C U+200B U+200D U+200E U+200F
 * U+FEFF -- several hundred consecutive two- and three-byte characters in a row.
 * A 2048-byte view boundary landing
 * inside that run is what trips the writer, so whether a given email carries a NUL
 * is decided purely by the byte length of the document, i.e. by the props. Two
 * templates rendered from the same order therefore disagree: the guest
 * confirmation lands clean while the staff alert does not.
 *
 * WHY THE GUARD BELONGS HERE AND NOT ONLY AT THE SINK
 * ---------------------------------------------------
 * The sandbox capture sink strips NUL today because that is where the damage first
 * became visible -- Postgres cannot hold NUL in a text column and rejects the whole
 * statement with `invalid byte sequence for encoding "UTF8"`. But the sink is only
 * one consumer of a rendered body. In cloud mode the same string goes straight to
 * Resend and never touches Postgres; it also flows into previews, template exports,
 * and anything that renders an email later. Corruption introduced by the renderer
 * has to be cleaned where it is introduced, or every present and future consumer
 * has to remember to clean it, and the one that forgets fails silently -- which is
 * exactly how this bug survived. The render boundary is the narrow waist: one
 * place, all consumers, independent of whether anything is persisted.
 */

/**
 * Control characters that must never leave a render.
 *
 * - U+0000 (NUL) is the hard requirement. Postgres cannot store it in
 *   `text`/`varchar` at all and aborts the statement, so any body carrying one is
 *   undeliverable through the sandbox sink.
 * - The remaining C0 controls except TAB/LF/CR are legal in Postgres but illegal in
 *   XML/XHTML text content, are mangled or dropped by quoted-printable and base64
 *   transfer encodings, and carry no meaning in an email body. U+001A additionally
 *   truncates the message in some legacy Windows readers.
 * - U+007F (DEL) and the C1 range U+0080-U+009F are invisible, never intentional,
 *   and get re-interpreted as windows-1252 punctuation by mail clients that guess
 *   the charset, silently rewriting the body.
 *
 * TAB, LF and CR are preserved: they are legitimate structure in both the HTML and
 * the plain-text part. So is everything from U+00A0 up, which is where the
 * zero-width characters <Preview> depends on live.
 */
const UNSAFE_CONTROL_SOURCE = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]';

/**
 * Unpaired surrogate halves. A lone surrogate has no UTF-8 encoding, so the pg
 * driver and every mail transport substitute U+FFFD for it, corrupting the body
 * without raising anything. Matched with lookarounds so well-formed pairs (emoji,
 * astral CJK) pass through untouched -- a naive `[\uD800-\uDFFF]` class would
 * delete half of every emoji.
 */
const LONE_SURROGATE_SOURCE =
  '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]';

/** Fresh regex per call -- a shared global regex carries `lastIndex` between calls. */
function unsafePattern(): RegExp {
  return new RegExp(`${UNSAFE_CONTROL_SOURCE}|${LONE_SURROGATE_SOURCE}`, 'g');
}

/** One occurrence of an unsafe character, for diagnostics. */
export interface UnsafeCharacter {
  /** UTF-16 code-unit offset into the rendered string. */
  index: number;
  /** The offending code point, e.g. `0x0000`. */
  codePoint: number;
}

/**
 * Locate every character that {@link stripUnsafeControlChars} would remove.
 * Exported so callers and tests can assert on a rendered body without restating
 * the policy.
 */
export function findUnsafeControlChars(value: string): UnsafeCharacter[] {
  const found: UnsafeCharacter[] = [];
  for (const match of value.matchAll(unsafePattern())) {
    found.push({ index: match.index ?? 0, codePoint: match[0].charCodeAt(0) });
  }
  return found;
}

/** `U+0000`-style label for a code point. */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Remove every character a text column or a mail transport cannot carry.
 *
 * Removal, not replacement: these characters never encode intent, so substituting
 * something visible would put junk in front of a customer. Each occurrence is
 * logged with its offset and surrounding text -- a rendered body should never
 * contain one, and if the renderer starts producing a new flavour of corruption we
 * want to hear about it rather than have it quietly scrubbed.
 *
 * @param context Short label naming the render that produced the string. Used only
 *   in the warning.
 */
export function stripUnsafeControlChars(value: string, context = 'email render'): string {
  const found = findUnsafeControlChars(value);
  if (found.length === 0) return value;

  const codePoints = [...new Set(found.map((c) => formatCodePoint(c.codePoint)))].join(', ');
  const first = found[0]!;
  const excerpt = JSON.stringify(value.slice(Math.max(0, first.index - 40), first.index + 40));
  console.warn(
    `[emails] stripped ${found.length} unsafe control character(s) from ${context}: ` +
      `${codePoints} (first at offset ${first.index}) near ${excerpt}`,
  );

  return value.replace(unsafePattern(), '');
}
