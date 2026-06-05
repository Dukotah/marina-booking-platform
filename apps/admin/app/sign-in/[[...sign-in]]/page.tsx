import { SignIn } from '@clerk/nextjs';

// Operator/staff sign-in. Catch-all route so Clerk can own its sub-paths
// (factor-two, sso-callback, etc.). Only reachable when Clerk is configured;
// until REQUIRE_CLERK_AUTH is on, the app uses the dev fallback and never redirects
// here. White-label theming is a later refinement (logo upload).
export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <SignIn />
    </main>
  );
}
