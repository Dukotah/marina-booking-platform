import type { Metadata } from 'next';
import { SignupForm } from './signup-form';

export const metadata: Metadata = {
  title: 'Create your booking site',
};

/**
 * Public self-serve operator signup page.
 *
 * This page is intentionally standalone — there is no AdminShell, sidebar, or
 * logged-in session context because the operator doesn't exist yet. Clerk is NOT
 * required here in dev mode; see middleware.ts where /signup is a public route.
 *
 * CLERK PROD NOTE: When REQUIRE_CLERK_AUTH is on, operators should complete the
 * Clerk <SignUp/> flow first (to create a real Clerk identity), then be handed off
 * to POST /signup with a Clerk bearer token so the API can associate
 * ownerAuthUserId with the Clerk user. In that mode, replace the <SignupForm/>
 * below with a two-step flow: Clerk SignUp → call createAccount with the token.
 */
export default function SignupPage() {
  return (
    <main className="flex min-h-screen items-start justify-center bg-slate-50 p-6 pt-16 sm:items-center sm:pt-6">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Create your booking site
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            Set up in minutes. No credit card required.
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm sm:px-8">
          <SignupForm />
        </div>

        {/* Footer links */}
        <p className="mt-6 text-center text-xs text-slate-400">
          Already have an account?{' '}
          <a href="/sign-in" className="font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900">
            Sign in
          </a>
        </p>
      </div>
    </main>
  );
}
