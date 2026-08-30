'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { MembershipHolding, PurchaseResult } from './types';

/**
 * Server actions for buying a membership.
 *
 * These run on the server for the same reason the checkout's actions do: the API
 * origin and the tenant slug stay server-side, and the browser never talks to the
 * API directly for anything that moves money. Actions are a public trust boundary,
 * so the input is validated here as well as in the client form and again in the API.
 *
 * The idempotency key is supplied by the caller and held for the life of ONE
 * attempt, exactly as CheckoutClient does: a double-tap or a transport retry reuses
 * it and resolves to the membership already issued; a guest who reads "your card was
 * declined" and tries again is making a NEW attempt and gets a new key.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const OPERATOR_SLUG = process.env.OPERATOR_SLUG ?? 'lake-sonoma';

const purchaseSchema = z.object({
  membershipId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(255),
  paymentSourceId: z.string().trim().min(1),
  firstName: z.string().trim().min(1, 'Enter your first name.').max(80),
  lastName: z.string().trim().min(1, 'Enter your last name.').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  phone: z.string().trim().max(32).optional(),
});

export type PurchaseMembershipInput = z.input<typeof purchaseSchema>;

/** Buy a membership: one API call that charges and issues, or does neither. */
export async function purchaseMembershipAction(
  input: PurchaseMembershipInput,
): Promise<PurchaseResult> {
  const parsed = purchaseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Please check your details and try again.',
      code: 'VALIDATION',
    };
  }
  const data = parsed.data;

  let res: Response;
  try {
    res = await fetch(
      `${API_URL}/api/memberships/${encodeURIComponent(data.membershipId)}/purchase`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-operator-slug': OPERATOR_SLUG,
          accept: 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify({
          idempotencyKey: data.idempotencyKey,
          sourceId: data.paymentSourceId,
          customer: {
            first_name: data.firstName,
            last_name: data.lastName,
            email: data.email,
            phone: data.phone || undefined,
          },
        }),
      },
    );
  } catch {
    // A transport failure is NOT proof nothing happened — the charge may have
    // landed. The guest is told to retry, and because the key is held for the
    // attempt, that retry resolves to the membership rather than buying a second.
    return {
      ok: false,
      error: 'We could not reach the booking service. Please try again.',
      code: 'NETWORK',
      indeterminate: true,
    };
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        holding?: MembershipHolding;
        replayed?: boolean;
        error?: string;
        code?: string;
        challenge?: { intentId: string | null; clientSecret: string | null; returnUrl: string | null };
      }
    | null;

  if (res.ok && payload?.holding) {
    // The account page lists what the customer holds; it is stale the moment this
    // returns.
    revalidatePath('/memberships');
    return { ok: true, holding: payload.holding, replayed: Boolean(payload.replayed) };
  }

  /*
   * Did this failure prove the money stayed put?
   *
   * A 5xx (including the simulator's `processing_error`, which models a processor
   * that took the money and never answered) and a 409 "already in flight" do not.
   * A 4xx decline or validation error does. The distinction decides whether the
   * caller keeps its idempotency key, and getting it backwards in the unsafe
   * direction is a double charge.
   */
  const indeterminate = res.status >= 500 || res.status === 409;

  return {
    ok: false,
    error: payload?.error ?? 'We could not complete this purchase. Please try again.',
    code: payload?.code,
    challenge: payload?.challenge ?? undefined,
    indeterminate,
  };
}

/**
 * Settle a 3DS challenge raised by a purchase attempt.
 *
 * There is no order to confirm against — a challenged purchase rolled back whole —
 * so this only moves the intent to succeeded. The caller then re-submits the
 * purchase with the SAME key, which replays the settled intent instead of charging
 * again. See the endpoint's own comment for why it is not `/api/payments/confirm`.
 */
export async function authenticateMembershipPaymentAction(
  membershipId: string,
  intentId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!membershipId || !intentId) {
    return { ok: false, error: 'We lost track of that payment. Please start again.' };
  }
  try {
    const res = await fetch(
      `${API_URL}/api/memberships/${encodeURIComponent(membershipId)}/authenticate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-operator-slug': OPERATOR_SLUG,
          accept: 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify({ intentId }),
      },
    );
    if (res.ok) return { ok: true };
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    return {
      ok: false,
      error: payload?.error ?? 'Your bank could not confirm this payment. Please try again.',
    };
  } catch {
    return { ok: false, error: 'We could not reach your bank. Please try again.' };
  }
}
