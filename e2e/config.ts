/**
 * Where the local stack lives, and the knobs the suite reads from the environment.
 *
 * Defaults match `pnpm dev:local` (docs/LOCAL-FIRST-BUILD.md §4.3) so the common case
 * needs no configuration at all. Everything is overridable because CI and a second
 * clone will not always use the same ports.
 */

/** Customer booking portal (apps/web). */
export const WEB_URL = trimSlash(process.env.E2E_WEB_URL ?? 'http://localhost:3000');

/** Hono API (apps/api). */
export const API_URL = trimSlash(process.env.E2E_API_URL ?? 'http://localhost:3001');

/** Operator console incl. the Local Console at /dev (apps/admin). */
export const ADMIN_URL = trimSlash(process.env.E2E_ADMIN_URL ?? 'http://localhost:3002');

/**
 * Tenant the suite books against. The API resolves it from `x-operator-slug`; the web
 * app resolves it from its own `OPERATOR_SLUG` env, so these two must agree or the
 * browser and the fixtures will be looking at different operators' data.
 */
export const OPERATOR_SLUG = process.env.E2E_OPERATOR_SLUG ?? process.env.OPERATOR_SLUG ?? 'lake-sonoma';

/**
 * Staff identity used for the handful of fixture calls that need staff rights
 * (creating a throwaway promo code, reading the staff order list). This is the
 * `x-dev-staff-id` shim in apps/api/src/middleware/auth.ts, which the API only honours
 * while REQUIRE_CLERK_AUTH is off — i.e. exactly the local-first mode the suite targets.
 */
export const STAFF_ID = process.env.E2E_STAFF_ID ?? 'dev-owner';

/**
 * Browser timezone. Pinned rather than inherited so that a date the fixture computes
 * from the availability API (which buckets days in the OPERATOR's timezone) is the same
 * date the browser prints in a day-strip label. Global setup asserts this matches the
 * operator's configured timezone and fails loudly if it does not.
 */
export const TIMEZONE = process.env.E2E_TIMEZONE ?? 'America/Los_Angeles';

/**
 * Budget for the throttled mobile funnel, in ms. The contract's target is a booking in
 * under 30 seconds on bad rural cell service (docs/LOCAL-FIRST-BUILD.md §6).
 */
export const MOBILE_FUNNEL_BUDGET_MS = Number(process.env.E2E_FUNNEL_BUDGET_MS ?? 30_000);

/**
 * The checkout payment mode the stack under test is running.
 *
 *   card    — a card is taken online; the submit button reads "Complete booking".
 *   reserve — no card online, pay at the marina; the button reads "Reserve my spot".
 *
 * This is not a test switch — it is a real per-deployment choice (docs mirror
 * apps/web/app/checkout/payment-mode.ts). The suite must assert the label the guest
 * actually sees, so a run against a reserve-mode stack (PAYMENT_MODE=reserve, which is
 * the LakeSonoma go-live configuration) asserts the reserve copy rather than failing to
 * find a button that was never rendered. Resolution mirrors the app: PAYMENT_MODE, then
 * NEXT_PUBLIC_PAYMENT_MODE, defaulting to "card".
 */
export type PaymentMode = 'card' | 'reserve';

function normalizePaymentMode(value: string | undefined): PaymentMode | null {
  const v = value?.trim().toLowerCase();
  if (v === 'reserve') return 'reserve';
  if (v === 'card') return 'card';
  return null;
}

export const PAYMENT_MODE: PaymentMode =
  normalizePaymentMode(process.env.E2E_PAYMENT_MODE) ??
  normalizePaymentMode(process.env.PAYMENT_MODE) ??
  normalizePaymentMode(process.env.NEXT_PUBLIC_PAYMENT_MODE) ??
  'card';

/**
 * The checkout submit button's accessible name, both its idle and its in-flight label,
 * for the active payment mode — kept as one regex so a locator matches whichever the
 * button currently shows. Mirrors `submitLabel` in
 * apps/web/components/checkout/CheckoutClient.tsx.
 */
export const CHECKOUT_SUBMIT_NAME =
  PAYMENT_MODE === 'reserve' ? /Reserve my spot|Reserving/ : /Complete booking|Processing/;

/**
 * What the checkout's live region announces while the booking is being submitted, for
 * the active payment mode. Mirrors the `role="status"` copy in CheckoutClient.
 */
export const CHECKOUT_SUBMITTING_STATUS =
  PAYMENT_MODE === 'reserve' ? /Reserving your spot/ : /Processing your booking/;

/** Absolute URL into the admin app (the `page` baseURL points at the customer site). */
export function adminUrl(path: string): string {
  return `${ADMIN_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
