'use server';

import { revalidatePath } from 'next/cache';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@marina/database';
import { getTenantDb, requirePermission } from '../../lib/session';

/**
 * Server actions for the gift-certificate slice. Issuing requires `operator:manage`
 * and runs through the tenant-scoped client (RLS). Certificates are single-use and
 * distinct from stored-value gift cards; redemption happens at checkout/POS via the
 * API, so the admin surface only issues + voids.
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function segment(len = 4): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}
function generateCode(): string {
  return `GC-${segment()}-${segment()}`;
}

const issueSchema = z.object({
  valueDollars: z.coerce.number().positive('Enter a positive dollar amount.'),
  activityId: z.string().trim().optional(),
  purchaserEmail: z.string().trim().email().optional().or(z.literal('')),
  recipientName: z.string().trim().max(160).optional(),
  recipientEmail: z.string().trim().email().optional().or(z.literal('')),
  message: z.string().trim().max(500).optional(),
});

export interface IssueCertResult {
  ok: boolean;
  error?: string;
  code?: string;
}

/** Issue a new ACTIVE gift certificate. */
export async function issueGiftCertificateAction(formData: FormData): Promise<IssueCertResult> {
  const { operatorId } = await requirePermission('operator:manage');
  const parsed = issueSchema.safeParse({
    valueDollars: formData.get('valueDollars'),
    activityId: formData.get('activityId') || undefined,
    purchaserEmail: formData.get('purchaserEmail') || undefined,
    recipientName: formData.get('recipientName') || undefined,
    recipientEmail: formData.get('recipientEmail') || undefined,
    message: formData.get('message') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const db = await getTenantDb();
  const valueCents = Math.round(parsed.data.valueDollars * 100);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const cert = await db.giftCertificate.create({
        data: {
          operator_id: operatorId,
          code,
          value_cents: valueCents,
          activity_id: parsed.data.activityId || null,
          status: 'ACTIVE',
          purchaser_email: parsed.data.purchaserEmail || null,
          recipient_name: parsed.data.recipientName || null,
          recipient_email: parsed.data.recipientEmail || null,
          message: parsed.data.message || null,
        },
      });
      revalidatePath('/gift-certificates');
      return { ok: true, code: cert.code };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  return { ok: false, error: 'Could not allocate a unique code; please retry.' };
}

/** Void an ACTIVE gift certificate so it can no longer be redeemed. */
export async function voidGiftCertificateAction(id: string): Promise<void> {
  await requirePermission('operator:manage');
  const db = await getTenantDb();
  await db.giftCertificate.updateMany({
    where: { id, status: 'ACTIVE' },
    data: { status: 'VOID' },
  });
  revalidatePath('/gift-certificates');
}
