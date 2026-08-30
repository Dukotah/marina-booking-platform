import { cookies } from 'next/headers';
import type { MembershipHolding, MembershipOffer } from './types';

/**
 * SERVER-ONLY data access for the memberships page.
 *
 * It reads `next/headers`, so it must never be pulled into a client bundle — the
 * same split `lib/orders.ts` makes for order-mutating calls. Only `page.tsx` and the
 * server action import it.
 *
 * Why not `lib/api.ts`'s `request()`: the holdings endpoint is authenticated by the
 * customer's magic-link session, and that helper has no way to attach a credential.
 * The API accepts the session as a bearer token precisely so a server component on a
 * different origin can forward the cookie it holds — see `currentCustomer` in
 * routes/customer-auth.ts. The public catalog call could use `request()`, but both
 * live here so the two have identical failure behaviour.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const OPERATOR_SLUG = process.env.OPERATOR_SLUG ?? 'lake-sonoma';
/** Matches app/account/magic/page.tsx, which is what mints this cookie. */
const SESSION_COOKIE = 'marina_customer_session';

function baseHeaders(): Record<string, string> {
  return {
    'x-operator-slug': OPERATOR_SLUG,
    accept: 'application/json',
  };
}

/**
 * The memberships on sale. An unreachable API is not an error page: memberships are
 * one section of a portal that must still render, so this answers with an empty
 * catalog and the caller shows a notice.
 */
export async function getMembershipOffers(): Promise<{ offers: MembershipOffer[]; failed: boolean }> {
  try {
    const res = await fetch(`${API_URL}/api/memberships`, {
      headers: baseHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) return { offers: [], failed: true };
    const data = (await res.json()) as { memberships?: MembershipOffer[] };
    return { offers: data.memberships ?? [], failed: false };
  } catch {
    return { offers: [], failed: true };
  }
}

export interface HoldingsResult {
  /** False when there is no valid customer session — the page prompts to sign in. */
  signedIn: boolean;
  holdings: MembershipHolding[];
}

/**
 * What the signed-in customer already holds.
 *
 * Deliberately session-gated rather than an email lookup: "show me what
 * name@example.com holds" is an enumeration oracle, and the portal already has a
 * magic-link session that carries a customer id the caller cannot widen.
 */
export async function getMyHoldings(): Promise<HoldingsResult> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return { signedIn: false, holdings: [] };

  try {
    const res = await fetch(`${API_URL}/api/memberships/mine`, {
      headers: { ...baseHeaders(), authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    // 401 is the ordinary "your link expired" case, not a failure worth shouting
    // about — the page falls back to the signed-out prompt.
    if (res.status === 401) return { signedIn: false, holdings: [] };
    if (!res.ok) return { signedIn: false, holdings: [] };
    const data = (await res.json()) as { holdings?: MembershipHolding[] };
    return { signedIn: true, holdings: data.holdings ?? [] };
  } catch {
    return { signedIn: false, holdings: [] };
  }
}
