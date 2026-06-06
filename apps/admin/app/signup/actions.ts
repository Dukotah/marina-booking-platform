'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

/**
 * Pre-tenant signup server actions.
 *
 * These actions call the API at the ROOT base (not under /api) because signup
 * is a pre-tenant operation — no operator id exists yet. For the same reason they
 * use a plain `fetch`, NOT lib/apiClient, which injects x-operator-id headers.
 *
 * CLERK PROD NOTE: When REQUIRE_CLERK_AUTH is on, the operator must complete
 * Clerk's <SignUp/> flow first, then POST /signup with the Clerk bearer token in
 * the Authorization header so the API can link ownerAuthUserId to a real Clerk
 * identity. The dev path below does NOT require a Clerk session.
 */

function apiBase(): string {
  const raw =
    process.env.API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    'http://localhost:3001';
  return raw.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Slug availability check
// ---------------------------------------------------------------------------

export interface SlugCheckResult {
  slug: string;
  available: boolean;
  reason?: string;
  suggestion?: string;
}

/**
 * Check whether a slug is available. Returns the API JSON directly so the
 * client component can show the live indicator + suggestion in one round-trip.
 * Returns null on network / unexpected error (caller treats as unknown state).
 */
export async function checkSlug(raw: string): Promise<SlugCheckResult | null> {
  const slug = raw.trim().toLowerCase();
  if (!slug) return null;
  try {
    const res = await fetch(
      `${apiBase()}/signup/slug-available?slug=${encodeURIComponent(slug)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as SlugCheckResult;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Create account
// ---------------------------------------------------------------------------

const signupSchema = z.object({
  businessName: z.string().trim().min(2, 'Business name must be at least 2 characters').max(160),
  ownerName: z.string().trim().max(160).optional(),
  ownerEmail: z
    .string()
    .trim()
    .email('Enter a valid email address')
    .max(320),
  slug: z.string().trim().max(63).optional(),
});

export interface CreateAccountResult {
  ok: false;
  error: string;
  /** Field-specific errors for inline display. */
  fieldErrors?: Record<string, string>;
}

/**
 * Validate inputs, POST to /signup, and on success set the dev operator cookie
 * then redirect to /onboarding.
 *
 * Cookie: `mb_dev_operator` — httpOnly, path `/`, sameSite `lax`, secure in
 * production. Value: `JSON.stringify({ operatorId, authUserId })`. This is read
 * by lib/session.ts's `devContextFromCookie()` so that subsequent requests to
 * the admin app act AS the newly-provisioned operator instead of the seed fallback.
 *
 * NOTE: `redirect()` throws internally (Next.js convention). Call it OUTSIDE any
 * try/catch to let it propagate, otherwise it silently swallows the redirect.
 */
export async function createAccount(
  input: z.infer<typeof signupSchema>,
): Promise<CreateAccountResult> {
  // --- Validate ---
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (!(path in fieldErrors)) fieldErrors[path] = issue.message;
    }
    return { ok: false, error: 'Please fix the highlighted fields.', fieldErrors };
  }

  const { businessName, ownerName, ownerEmail, slug } = parsed.data;

  // --- POST /signup ---
  let body: { operatorId: string; slug: string; locationCode: string; ownerAuthUserId: string };
  try {
    const res = await fetch(`${apiBase()}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName,
        ...(ownerName ? { ownerName } : {}),
        ownerEmail,
        ...(slug ? { slug } : {}),
      }),
      cache: 'no-store',
    });

    const json = (await res.json()) as
      | { operatorId: string; slug: string; locationCode: string; ownerAuthUserId: string }
      | { error: string; code?: string };

    if (!res.ok) {
      const err = json as { error: string; code?: string };
      if (err.code === 'SLUG_TAKEN') {
        return {
          ok: false,
          error: 'That URL slug is already taken. Try a different one.',
          fieldErrors: { slug: 'Already taken — choose a different slug.' },
        };
      }
      return { ok: false, error: err.error ?? 'Signup failed. Please try again.' };
    }

    body = json as typeof body;
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }

  // --- Set dev operator cookie ---
  // httpOnly so JavaScript can't read it; the admin server components read it
  // via lib/session.ts → devContextFromCookie().
  const cookieStore = cookies();
  cookieStore.set('mb_dev_operator', JSON.stringify({
    operatorId: body.operatorId,
    authUserId: body.ownerAuthUserId,
  }), {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  // --- Redirect (must be outside try/catch) ---
  redirect('/onboarding');
}
