/**
 * Demo-mode switch for the customer portal.
 *
 * When on, the typed API client (`@/lib/api`) serves a seeded, in-memory catalog
 * and a cookie-backed order store instead of calling the Hono API — so the whole
 * booking funnel runs with NO database, NO API, and NO Stripe. This lets the MVP
 * be reviewed as a live, clickable link before any infra is stood up.
 *
 * Default ON in this build; set `NEXT_PUBLIC_DEMO_MODE=0` to force the real API
 * path back on. Pure (no imports) so it is safe in both server and client bundles.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === '0' ? false : true;
