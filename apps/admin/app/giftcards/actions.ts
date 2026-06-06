'use server';

/**
 * Gift-card server actions.
 *
 * All money operations go through the API (which owns the signed ledger and the
 * atomicity guarantees). Each action:
 *   - gates on the required permission before touching the API;
 *   - maps AdminApiError.message into a friendly client result;
 *   - NEVER throws to the client — always returns { ok, … };
 *   - revalidates /giftcards after any mutation.
 *
 * Permissions mirror the API:
 *   issue / redeem  → order:write
 *   adjust / void / reactivate → order:refund
 *   list / balance lookup      → order:read  (enforced by the page; actions
 *                                              called by the page already hold it)
 */

import { revalidatePath } from 'next/cache';
import { AuthorizationError } from '@marina/auth';
import {
  apiGet,
  apiPost,
  AdminApiError,
} from '../../lib/apiClient';
import { requirePermission } from '../../lib/session';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface GiftCard {
  id: string;
  code: string;
  initialCents: number;
  balanceCents: number;
  isActive: boolean;
  purchaserName: string | null;
  purchaserEmail: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  message: string | null;
  issuedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface GiftCardsListResult {
  ok: true;
  giftCards: GiftCard[];
  pagination: { total: number; limit: number; offset: number };
}

export interface GiftCardResult {
  ok: true;
  giftCard: GiftCard;
}

export interface FailResult {
  ok: false;
  error: string;
}

export type ActionResult<T = GiftCardResult> = T | FailResult;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fail(error: string): FailResult {
  return { ok: false, error };
}

function mapError(err: unknown, fallback: string): FailResult {
  if (err instanceof AdminApiError) return fail(err.message);
  if (err instanceof AuthorizationError) return fail(err.message);
  console.error('[giftcards action]', err);
  return fail(fallback);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listGiftCardsAction(opts?: {
  limit?: number;
  offset?: number;
}): Promise<ActionResult<GiftCardsListResult>> {
  try {
    await requirePermission('order:read');
    const data = await apiGet<{ giftCards: GiftCard[]; pagination: { total: number; limit: number; offset: number } }>(
      '/api/giftcards',
      { limit: opts?.limit ?? 50, offset: opts?.offset ?? 0 },
    );
    return { ok: true, giftCards: data.giftCards, pagination: data.pagination };
  } catch (err) {
    return mapError(err, 'Could not load gift cards.');
  }
}

// ---------------------------------------------------------------------------
// Issue (sell) a gift card
// ---------------------------------------------------------------------------

export interface IssueInput {
  /** Amount in integer CENTS */
  amountCents: number;
  purchaserName?: string | null;
  purchaserEmail?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  message?: string | null;
  /** ISO-8601 datetime string */
  expiresAt?: string | null;
}

export async function issueGiftCardAction(
  input: IssueInput,
): Promise<ActionResult<GiftCardResult>> {
  try {
    await requirePermission('order:write');
    const data = await apiPost<{ giftCard: GiftCard }>('/api/giftcards', input);
    revalidatePath('/giftcards');
    return { ok: true, giftCard: data.giftCard };
  } catch (err) {
    return mapError(err, 'Could not issue gift card.');
  }
}

// ---------------------------------------------------------------------------
// Balance / detail lookup by code (public endpoint, no permission required)
// ---------------------------------------------------------------------------

export interface BalanceLookupResult {
  ok: true;
  code: string;
  balanceCents: number;
  isActive: boolean;
  expired: boolean;
  expiresAt: string | null;
}

export async function lookupBalanceAction(
  code: string,
): Promise<ActionResult<BalanceLookupResult>> {
  const trimmed = code.trim();
  if (!trimmed) return fail('Enter a gift card code.');
  try {
    // This is a public endpoint — no requirePermission needed.
    // We still go through apiGet which injects operator headers.
    const data = await apiGet<{
      code: string;
      balanceCents: number;
      isActive: boolean;
      expired: boolean;
      expiresAt: string | null;
    }>(`/api/giftcards/${encodeURIComponent(trimmed)}/balance`);
    return { ok: true, ...data };
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 404) {
      return fail('No gift card found for that code.');
    }
    return mapError(err, 'Could not look up the gift card.');
  }
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

export interface RedeemInput {
  /** Amount to redeem in integer CENTS */
  amountCents: number;
  orderId?: string;
  note?: string;
}

export interface RedeemResult {
  ok: true;
  giftCard: GiftCard;
  amountAppliedCents: number;
  balanceCents: number;
}

export async function redeemGiftCardAction(
  code: string,
  input: RedeemInput,
): Promise<ActionResult<RedeemResult>> {
  try {
    await requirePermission('order:write');
    const data = await apiPost<{
      giftCard: GiftCard;
      amountAppliedCents: number;
      balanceCents: number;
    }>(`/api/giftcards/${encodeURIComponent(code)}/redeem`, input);
    revalidatePath('/giftcards');
    return { ok: true, ...data };
  } catch (err) {
    return mapError(err, 'Could not redeem gift card.');
  }
}

// ---------------------------------------------------------------------------
// Adjust (signed balance correction)
// ---------------------------------------------------------------------------

export interface AdjustInput {
  /** Signed delta in integer CENTS; positive credits, negative debits. */
  deltaCents: number;
  reason: string;
}

export interface AdjustResult {
  ok: true;
  giftCard: GiftCard;
  deltaCents: number;
  balanceCents: number;
}

export async function adjustGiftCardAction(
  code: string,
  input: AdjustInput,
): Promise<ActionResult<AdjustResult>> {
  try {
    await requirePermission('order:refund');
    const data = await apiPost<{
      giftCard: GiftCard;
      deltaCents: number;
      balanceCents: number;
    }>(`/api/giftcards/${encodeURIComponent(code)}/adjust`, input);
    revalidatePath('/giftcards');
    return { ok: true, ...data };
  } catch (err) {
    return mapError(err, 'Could not adjust gift card balance.');
  }
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

export async function voidGiftCardAction(
  code: string,
  reason?: string,
): Promise<ActionResult<GiftCardResult>> {
  try {
    await requirePermission('order:refund');
    const data = await apiPost<{ giftCard: GiftCard }>(
      `/api/giftcards/${encodeURIComponent(code)}/void`,
      reason ? { reason } : {},
    );
    revalidatePath('/giftcards');
    return { ok: true, giftCard: data.giftCard };
  } catch (err) {
    return mapError(err, 'Could not void gift card.');
  }
}

// ---------------------------------------------------------------------------
// Reactivate
// ---------------------------------------------------------------------------

export async function reactivateGiftCardAction(
  code: string,
  reason?: string,
): Promise<ActionResult<GiftCardResult>> {
  try {
    await requirePermission('order:refund');
    const data = await apiPost<{ giftCard: GiftCard }>(
      `/api/giftcards/${encodeURIComponent(code)}/reactivate`,
      reason ? { reason } : {},
    );
    revalidatePath('/giftcards');
    return { ok: true, giftCard: data.giftCard };
  } catch (err) {
    return mapError(err, 'Could not reactivate gift card.');
  }
}
