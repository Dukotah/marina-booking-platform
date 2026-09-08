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
 *
 * FAIL-OPEN CAVEAT: because the default is ON, the var MUST reach the web
 * process. Next only reads .env from apps/web/, not the repo root — so when the
 * web app is started STANDALONE (e.g. a crash restart of just :3000 outside
 * turbo), the root .env is invisible and this silently falls back to demo
 * fixtures. That makes every real Book button (/activities/pontoon-5-person)
 * 404 against the fake catalog. apps/web/.env.local (generated from the root
 * .env by scripts/setup-local.sh + scripts/dev-local.sh) closes that gap; see
 * apps/web/.env.local.example.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === '0' ? false : true;
