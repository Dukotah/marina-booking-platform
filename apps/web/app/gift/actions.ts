'use server';

/**
 * Server action for the public gift-card purchase page.
 *
 * The typed API client (`@/lib/orders`) is server-only — it reads API_URL +
 * OPERATOR_SLUG from the environment and talks to the API server-side, so the
 * browser never touches the API or holds the tenant resolution. The action is a
 * trust boundary, so it re-validates its input with zod before forwarding.
 *
 * MONEY DISCIPLINE: the action forwards the buyer's chosen denomination only as a
 * REQUEST. The API is the price authority — it re-derives the amount from its
 * allowed denomination set and charges + issues for that same number, so a tampered
 * client amount is rejected server-side, never charged. All money is integer cents.
 *
 * Payment source: this showcase deployment runs the local payment sandbox, which
 * settles a well-known test source. We use it here so the gift flow is exercisable
 * end to end with no Stripe account — the same posture the booking checkout takes in
 * sandbox mode. A real-Stripe deployment would collect a card via Stripe Elements
 * (a follow-up, mirroring the checkout's PaymentSection).
 */

import { z } from 'zod';
import { purchaseGiftCard } from '@/lib/orders';
import { isApiError } from '@/lib/api';

/** The sandbox/fake payment source the local simulator settles as SUCCEEDED. */
const SANDBOX_SOURCE = 'pm_card_visa';

const giftInputSchema = z.object({
  amountCents: z.coerce.number().int().positive(),
  recipientEmail: z.string().trim().email('Enter a valid recipient email'),
  recipientName: z.string().trim().max(160).optional(),
  purchaserName: z.string().trim().max(160).optional(),
  purchaserEmail: z.string().trim().email().optional().or(z.literal('')),
  message: z.string().trim().max(500).optional(),
});

export type GiftActionResult =
  | {
      ok: true;
      code: string;
      amountChargedCents: number;
      recipientEmail: string;
      emailSent: boolean;
    }
  | { ok: false; error: string; code?: string };

export async function buyGiftCard(input: {
  amountCents: number;
  recipientEmail: string;
  recipientName?: string;
  purchaserName?: string;
  purchaserEmail?: string;
  message?: string;
}): Promise<GiftActionResult> {
  const parsed = giftInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first?.message ?? 'Please check the gift details and try again.' };
  }
  const data = parsed.data;

  try {
    const result = await purchaseGiftCard({
      amountCents: data.amountCents,
      sourceId: SANDBOX_SOURCE,
      recipientEmail: data.recipientEmail,
      recipientName: data.recipientName || undefined,
      purchaserName: data.purchaserName || undefined,
      purchaserEmail: data.purchaserEmail || undefined,
      message: data.message || undefined,
    });
    return {
      ok: true,
      code: result.giftCard.code,
      amountChargedCents: result.amountChargedCents,
      recipientEmail: result.giftCard.recipientEmail ?? data.recipientEmail,
      emailSent: result.emailSent,
    };
  } catch (err) {
    return {
      ok: false,
      error: isApiError(err)
        ? err.message
        : 'We could not complete your gift card purchase. Please try again.',
      code: isApiError(err) ? err.code : undefined,
    };
  }
}
