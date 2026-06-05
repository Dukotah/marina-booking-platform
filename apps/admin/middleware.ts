import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

/**
 * Admin auth middleware (0.7 / D-012).
 *
 * Rollout is controlled by a single switch so we never lock anyone out before the
 * Clerk dashboard is configured:
 *   - No publishable key            -> passthrough (Clerk absent; app uses the dev
 *                                      OWNER fallback in lib/session).
 *   - Keys present, flag OFF (default) -> clerkMiddleware runs (so `auth()` works) but
 *                                      protects nothing; lib/session still returns the
 *                                      dev fallback, so the dashboard stays explorable.
 *   - REQUIRE_CLERK_AUTH=true + keys -> every non-public route requires a real session.
 *
 * Flip REQUIRE_CLERK_AUTH=true once the Clerk dashboard has sign-in URLs + your staff
 * user. /sign-in and /sign-up are always public.
 */
const HAS_CLERK = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
const ENFORCE = process.env.REQUIRE_CLERK_AUTH === 'true' && HAS_CLERK;

const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)']);

export default HAS_CLERK
  ? clerkMiddleware(async (auth, req) => {
      if (ENFORCE && !isPublicRoute(req)) {
        await auth.protect();
      }
    })
  : () => NextResponse.next();

export const config = {
  // Run on everything except Next internals and static files (so server components
  // that call Clerk's `auth()` have the middleware context available).
  matcher: ['/((?!_next|.*\\..*).*)'],
};
