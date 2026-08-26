/**
 * Money helpers for assertions.
 *
 * Money in this product is integer cents everywhere (docs/ARCHITECTURE.md), and the UI
 * prints it through `formatUSD`. A spec that wants to compare a screen figure to a
 * computed one converts the SCREEN value down to cents rather than formatting the
 * computed one up — that way a locale or a stray non-breaking space cannot make a
 * correct total look wrong.
 */

/** `$1,234.50` for 123450 cents — matches @marina/core's formatUSD. */
export function formatUSD(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/**
 * Pull the first USD amount out of a blob of screen text and return it as integer
 * cents. Returns null when the text carries no amount, so a caller can assert on that
 * rather than on a silently-wrong 0.
 */
export function parseUSD(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /-?\$\s?([\d,]+)(?:\.(\d{2}))?/.exec(text);
  if (!match) return null;
  const dollars = Number(match[1]!.replace(/,/g, ''));
  const cents = Number(match[2] ?? '0');
  if (!Number.isFinite(dollars) || !Number.isFinite(cents)) return null;
  const total = dollars * 100 + cents;
  return text.trim().startsWith('-') || text.includes('−') ? -total : total;
}

/** A percent discount applied to a cents subtotal, rounded the way @marina/core rounds. */
export function percentDiscountCents(subtotalCents: number, percent: number): number {
  return Math.round((subtotalCents * percent) / 100);
}
