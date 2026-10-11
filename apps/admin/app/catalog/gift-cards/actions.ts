'use server';

import { revalidatePath } from 'next/cache';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@marina/database';
import { getTenantDb, requirePermission } from '../../../lib/session';

/**
 * Server actions for the stored-value gift-card slice. Issuing requires
 * `operator:manage` and runs through the tenant-scoped client (RLS). Gift cards
 * hold a balance in integer cents (initial == balance at issue) and are DISTINCT
 * from single-use gift certificates. Redemption happens at checkout/POS via the
 * API (`POST /api/gift-cards/redeem`), so this admin surface only issues + voids
 * and reports outstanding liability. The code-generation + uppercase-normalize
 * shape mirrors services/gift-cards.ts so issued codes redeem cleanly.
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function segment(len = 4): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}
function generateCode(): string {
  return `GIFT-${segment()}-${segment()}`;
}

const issueSchema = z.object({
  valueDollars: z.coerce.number().positive('Enter a positive dollar amount.'),
  purchaserEmail: z.string().trim().email().optional().or(z.literal('')),
  recipientName: z.string().trim().max(160).optional(),
  recipientEmail: z.string().trim().email().optional().or(z.literal('')),
  message: z.string().trim().max(500).optional(),
  expiresAt: z.string().trim().optional().or(z.literal('')),
});

export interface IssueGiftCardResult {
  ok: boolean;
  error?: string;
  code?: string;
}

/** Issue a new ACTIVE stored-value gift card (initial balance == value). */
export async function issueGiftCardAction(formData: FormData): Promise<IssueGiftCardResult> {
  const { operatorId } = await requirePermission('operator:manage');
  const parsed = issueSchema.safeParse({
    valueDollars: formData.get('valueDollars'),
    purchaserEmail: formData.get('purchaserEmail') || undefined,
    recipientName: formData.get('recipientName') || undefined,
    recipientEmail: formData.get('recipientEmail') || undefined,
    message: formData.get('message') || undefined,
    expiresAt: formData.get('expiresAt') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  // A date-only value from <input type="date"> is parsed at UTC midnight; a card
  // "expiring 2026-12-31" should be good through that day, so land on end-of-day.
  let expiresAt: Date | null = null;
  if (parsed.data.expiresAt) {
    const d = new Date(`${parsed.data.expiresAt}T23:59:59`);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: 'Enter a valid expiry date.' };
    }
    expiresAt = d;
  }

  const db = await getTenantDb();
  const valueCents = Math.round(parsed.data.valueDollars * 100);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const card = await db.giftCard.create({
        data: {
          operator_id: operatorId,
          code,
          initial_cents: valueCents,
          balance_cents: valueCents,
          status: 'ACTIVE',
          purchaser_email: parsed.data.purchaserEmail || null,
          recipient_name: parsed.data.recipientName || null,
          recipient_email: parsed.data.recipientEmail || null,
          message: parsed.data.message || null,
          expires_at: expiresAt,
        },
      });
      revalidatePath('/catalog/gift-cards');
      return { ok: true, code: card.code };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  return { ok: false, error: 'Could not allocate a unique code; please retry.' };
}

/** Void a gift card so its remaining balance can no longer be redeemed. */
export async function voidGiftCardAction(id: string): Promise<void> {
  await requirePermission('operator:manage');
  const db = await getTenantDb();
  await db.giftCard.updateMany({
    where: { id, status: 'ACTIVE' },
    data: { status: 'VOID' },
  });
  revalidatePath('/catalog/gift-cards');
}
