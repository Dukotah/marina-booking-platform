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

/** Absolute URL into the admin app (the `page` baseURL points at the customer site). */
export function adminUrl(path: string): string {
  return `${ADMIN_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
