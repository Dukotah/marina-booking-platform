import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getBrand, brandStyle } from '@/lib/brand';
import { DEMO_MODE } from '@/lib/demo/config';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
};

// Carries a single-use credential in the URL — never prerender, never cache.
export const dynamic = 'force-dynamic';

/**
 * Magic-link landing page.
 *
 * The customer clicks the link in their email (or, in a local sandbox run, in the
 * Local Console inbox) and arrives here with a one-time token in the query string.
 *
 * WHY THIS PAGE DOES NOT REDEEM ON LOAD. The token is single-use, and a lot of
 * things open a link before a human does: corporate mail scanners, link
 * previewers, the browser's own prefetch. Any of them would burn the token and
 * the real customer would land on "this link is no longer valid" — the classic
 * way magic-link flows break in the field. So the GET is inert and redemption
 * happens on a POST the customer makes by pressing a button. It also works with
 * JavaScript disabled, because it is a plain form.
 *
 * The session cookie is set HERE, on the portal's own origin, rather than being
 * accepted from the API's `Set-Cookie` — in production the API sits on a
 * different host, and a cookie it sets is not one this app can read.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const OPERATOR_SLUG = process.env.OPERATOR_SLUG ?? 'lake-sonoma';
const SESSION_COOKIE = 'marina_customer_session';

interface RedeemedBooking {
  orderNumber: string;
  status: string;
  startsAt: string | null;
}

interface RedeemResponse {
  session: { token: string; expiresAt: string };
  customer: { id: string; email: string; firstName: string; lastName: string };
  bookings: RedeemedBooking[];
}

/**
 * Exchange the token for a session, store it, and send the customer to their
 * reservation.
 *
 * Every failure lands back here with a generic `error` flag: which part failed
 * (unknown token, expired, already used) is only useful to someone probing, and
 * the customer's next step — request a fresh link — is the same in all of them.
 */
async function completeSignIn(formData: FormData): Promise<void> {
  'use server';

  const token = String(formData.get('token') ?? '').trim();
  if (!token) redirect('/account/magic?error=1');

  let destination = '/account/magic?error=1';

  try {
    const res = await fetch(`${API_URL}/api/customer-auth/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-operator-slug': OPERATOR_SLUG,
      },
      body: JSON.stringify({ token }),
      cache: 'no-store',
    });

    if (res.ok) {
      const data = (await res.json()) as RedeemResponse;
      const expires = new Date(data.session.expiresAt);

      cookies().set(SESSION_COOKIE, data.session.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        expires: Number.isNaN(expires.getTime()) ? undefined : expires,
      });

      // The reservation view still addresses a single order by number, so pick
      // the one the customer most likely came back for: the next upcoming trip,
      // falling back to the most recent booking. (The session now covers the
      // whole list — see the handoff note about the bookings page.)
      const upcoming = data.bookings.find((b) => b.status === 'UPCOMING');
      const chosen = upcoming ?? data.bookings[0];
      destination = chosen
        ? `/account/bookings?order=${encodeURIComponent(chosen.orderNumber)}` +
          `&email=${encodeURIComponent(data.customer.email)}`
        : '/account/magic?empty=1';
    }
  } catch {
    // Network / API down. Same generic landing — with the API unreachable there
    // is nothing more specific we can honestly tell them.
    destination = '/account/magic?error=1';
  }

  // Outside the try: `redirect` signals by throwing, and a catch would swallow it.
  redirect(destination);
}

function Shell({ children }: { children: React.ReactNode }) {
  const brand = getBrand();
  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
      <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
      <div className="mt-3 space-y-4 text-sm text-slate-600">{children}</div>
    </section>
  );
}

function RequestAnother() {
  return (
    <Link
      href="/account"
      className="inline-block w-full rounded-lg bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:opacity-90"
    >
      Get a new link
    </Link>
  );
}

interface SearchParams {
  token?: string;
  error?: string;
  empty?: string;
}

export default function MagicLinkPage({ searchParams }: { searchParams: SearchParams }) {
  const brand = getBrand();

  if (DEMO_MODE) {
    return (
      <Shell>
        <Card title="Sign-in links are off in the demo">
          <p>
            This preview runs without a database, so there is no mailbox to send a
            sign-in link to. Look up a demo booking by its confirmation number instead.
          </p>
          <Link href="/account" className="font-medium text-brand hover:underline">
            Back to My Bookings
          </Link>
        </Card>
      </Shell>
    );
  }

  if (searchParams.empty) {
    return (
      <Shell>
        <Card title="You’re signed in">
          <p>
            We could not find any reservations under that email yet. When you book with{' '}
            {brand.name}, it will show up here.
          </p>
          <Link
            href="/"
            className="inline-block w-full rounded-lg bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            Browse activities
          </Link>
        </Card>
      </Shell>
    );
  }

  const token = searchParams.token?.trim();

  if (!token || searchParams.error) {
    return (
      <Shell>
        <Card title="That link didn’t work">
          <p role="alert">
            Sign-in links expire after a short while and can only be used once. Ask for
            a fresh one and it will arrive in your inbox in a moment.
          </p>
          <RequestAnother />
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card title="Sign in to your bookings">
        <p>
          Confirm it’s you to see your reservations with {brand.name}. This link works
          once, and only from this page.
        </p>
        <form action={completeSignIn} className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <button
            type="submit"
            className="w-full rounded-lg bg-brand px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            View my bookings
          </button>
        </form>
        <p className="text-xs text-slate-500">
          Didn’t request this? You can close this page — nothing has changed.
        </p>
      </Card>
    </Shell>
  );
}
