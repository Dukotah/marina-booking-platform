'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  calculatePricing,
  createId,
  formatUSD,
  generateOrderNumber,
  type PricingFee,
  type PricingItem,
} from '@marina/core';
import { withTenant } from '@marina/database';
import { getOperatorContext, getTenantDb, requirePermission } from '../../lib/session';
import type {
  CodeLookupResult,
  GiftCardCheckResult,
  SaleInput,
  SaleResult,
} from '../../components/pos/types';

/** Normalize an operator-entered gift-card code (case + surrounding whitespace). */
function normalizeGiftCardCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Server actions backing the integrated POS terminal.
 *
 * Everything here:
 *  - requires the `pos:operate` permission (throws AuthorizationError otherwise),
 *  - re-derives the operator from the session (never trusts client-supplied ids),
 *  - runs through the tenant-scoped client / withTenant so RLS isolates the tenant,
 *  - writes explicit `operator_id` where-clauses as defense in depth, and
 *  - computes money server-side via @marina/core (the client total is never trusted).
 *
 * The register is the anti-Singenuity wedge: one app, one login. A POS sale creates
 * the same Order/OrderItem/Payment rows a customer booking does, tagged STAFF channel.
 */

// --- Validation -----------------------------------------------------------

const cartLineSchema = z.object({
  kind: z.enum(['BOOKING', 'MERCHANDISE', 'MISC']),
  label: z.string().trim().min(1).max(200),
  unitPriceCents: z.number().int(),
  quantity: z.number().int().positive().max(999),
  activityId: z.string().min(1).optional(),
  rateId: z.string().min(1).optional(),
  timeslotId: z.string().min(1).optional(),
  merchandiseId: z.string().min(1).optional(),
});

const saleSchema = z.object({
  lines: z.array(cartLineSchema).min(1, 'Add at least one item to the cart.'),
  paymentMethod: z.enum(['CASH', 'CARD', 'GIFT_CARD']),
  tipCents: z.number().int().nonnegative().default(0),
  cashTenderedCents: z.number().int().nonnegative().optional(),
  giftCardCode: z.string().trim().min(1).max(64).optional(),
  customer: z
    .object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
      email: z.string().trim().toLowerCase().email().max(254).optional().or(z.literal('')),
      phone: z.string().trim().max(32).optional(),
    })
    .optional(),
});

// --- Code / QR lookup -----------------------------------------------------

/**
 * Look up an order by its human order number (the value encoded in booking QR
 * codes and on receipts). Used by the register's scan/search box so staff can pull
 * up an existing booking to take a balance payment or check a guest in.
 */
export async function lookupByCode(rawCode: string): Promise<CodeLookupResult> {
  await requirePermission('pos:operate');

  const code = rawCode.trim().toUpperCase();
  if (!code) return { found: false, message: 'Enter a code to search.' };

  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const order = await db.order.findFirst({
    where: { operator_id: operatorId, order_number: code },
    select: {
      id: true,
      order_number: true,
      status: true,
      total_cents: true,
      balance_due_cents: true,
      customer: { select: { first_name: true, last_name: true } },
    },
  });

  if (!order) {
    return { found: false, message: `No order found for "${code}".` };
  }

  return {
    found: true,
    order: {
      id: order.id,
      orderNumber: order.order_number,
      customerName: `${order.customer.first_name} ${order.customer.last_name}`.trim(),
      status: order.status,
      totalCents: order.total_cents,
      balanceDueCents: order.balance_due_cents,
    },
  };
}

// --- Gift-card balance check ---------------------------------------------

/**
 * Look up a gift card by code and report its usable balance for the register.
 * Mirrors the API's public `checkGiftCard` (services/gift-cards.ts) so staff can
 * preview a card before applying it as tender. Never mutates the card.
 */
export async function checkGiftCardCode(rawCode: string): Promise<GiftCardCheckResult> {
  await requirePermission('pos:operate');

  const code = normalizeGiftCardCode(rawCode);
  if (!code) {
    return { valid: false, code: '', balanceCents: 0, status: 'VOID', reason: 'Enter a gift card code.' };
  }

  const { operatorId } = await getOperatorContext();
  const db = await getTenantDb();

  const card = await db.giftCard.findFirst({
    where: { operator_id: operatorId, code },
    select: { code: true, balance_cents: true, status: true, expires_at: true },
  });

  if (!card) {
    return { valid: false, code, balanceCents: 0, status: 'VOID', reason: 'No gift card with that code.' };
  }

  const base = { code: card.code, balanceCents: card.balance_cents } as const;
  if (card.status === 'VOID') {
    return { valid: false, ...base, status: 'VOID', reason: 'This gift card has been voided.' };
  }
  if (card.status === 'REDEEMED' || card.balance_cents <= 0) {
    return { valid: false, ...base, status: 'REDEEMED', reason: 'This gift card has no remaining balance.' };
  }
  if (card.expires_at && card.expires_at.getTime() < Date.now()) {
    return { valid: false, ...base, status: 'EXPIRED', reason: 'This gift card has expired.' };
  }
  return { valid: true, ...base, status: 'ACTIVE' };
}

// --- Checkout -------------------------------------------------------------

/** Resolve (or create) the customer for a register sale. Defaults to a walk-up record. */
const WALKUP_EMAIL = 'walk-in@register.local';

/**
 * Complete a register sale: persist an Order with its items + a Payment, decrement
 * timeslot capacity for any walk-up bookings, and decrement merchandise stock.
 *
 * Pricing is recomputed server-side from the operator's fee config; the client's
 * numbers are display-only. Cash sales also return change due.
 */
export async function submitSale(input: SaleInput): Promise<SaleResult> {
  const { operatorId, auth } = await requirePermission('pos:operate');

  const parsed = saleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid sale.' };
  }
  const sale = parsed.data;

  try {
    const result = await withTenant(operatorId, async (tx) => {
      // 1. Operator branding/code + fee config (recompute money authoritatively).
      const operator = await tx.operator.findFirst({
        where: { id: operatorId },
        select: { location_code: true },
      });
      if (!operator) throw new SaleError('Operator not found.');

      const feeRows = await tx.fee.findMany({
        where: { operator_id: operatorId, enabled: true, activity_id: null },
        select: { name: true, type: true, value: true },
      });
      const fees: PricingFee[] = feeRows.map((f) => ({
        name: f.name,
        type: f.type,
        value: f.value,
      }));

      // 2. Re-validate booking lines against live catalog data (price + capacity).
      //    We trust DB prices, not the client, and verify slots have room.
      type ResolvedLine = {
        kind: 'BOOKING' | 'MERCHANDISE' | 'MISC';
        label: string;
        unitPriceCents: number;
        quantity: number;
        activityId?: string;
        rateId?: string;
        timeslotId?: string;
        merchandiseId?: string;
        /** Category/variant snapshots for the persisted merchandise sale line. */
        merchCategory?: string;
        merchVariant?: string | null;
      };
      const resolved: ResolvedLine[] = [];

      for (const line of sale.lines) {
        if (line.kind === 'BOOKING') {
          if (!line.activityId || !line.rateId || !line.timeslotId) {
            throw new SaleError('A booking line is missing its activity, rate, or timeslot.');
          }
          const rate = await tx.rate.findFirst({
            where: { id: line.rateId, operator_id: operatorId, activity_id: line.activityId },
            select: { id: true, price_cents: true, name_external: true },
          });
          if (!rate) throw new SaleError('Selected rate is no longer available.');

          const slot = await tx.timeslot.findFirst({
            where: { id: line.timeslotId, operator_id: operatorId, activity_id: line.activityId },
            select: { id: true, capacity_total: true, capacity_booked: true, status: true },
          });
          if (!slot) throw new SaleError('Selected timeslot is no longer available.');
          if (slot.capacity_booked + line.quantity > slot.capacity_total) {
            throw new SaleError('Not enough capacity remaining for that timeslot.');
          }

          resolved.push({
            kind: 'BOOKING',
            label: line.label,
            unitPriceCents: rate.price_cents,
            quantity: line.quantity,
            activityId: line.activityId,
            rateId: line.rateId,
            timeslotId: line.timeslotId,
          });
        } else if (line.kind === 'MERCHANDISE') {
          if (!line.merchandiseId) throw new SaleError('A merchandise line is missing its item.');
          const item = await tx.merchandiseItem.findFirst({
            where: { id: line.merchandiseId, operator_id: operatorId, is_active: true },
            select: {
              id: true,
              name: true,
              category: true,
              variant: true,
              cost_cents: true,
              on_hand_qty: true,
            },
          });
          if (!item) throw new SaleError('A merchandise item is no longer available.');
          if (item.on_hand_qty !== null && item.on_hand_qty < line.quantity) {
            throw new SaleError(`Not enough "${item.name}" in stock.`);
          }
          resolved.push({
            kind: 'MERCHANDISE',
            label: item.name,
            unitPriceCents: item.cost_cents,
            quantity: line.quantity,
            merchandiseId: item.id,
            merchCategory: item.category,
            merchVariant: item.variant,
          });
        } else {
          // MISC / gift / custom charge — price comes from the register operator.
          if (line.unitPriceCents < 0) throw new SaleError('A misc charge cannot be negative.');
          resolved.push({
            kind: 'MISC',
            label: line.label,
            unitPriceCents: line.unitPriceCents,
            quantity: line.quantity,
          });
        }
      }

      // 3. Authoritative pricing.
      const items: PricingItem[] = resolved.map((l) => ({
        unitPriceCents: l.unitPriceCents,
        quantity: l.quantity,
      }));
      const pricing = calculatePricing({ items, fees, tipCents: sale.tipCents });

      // 4. Gift-card tender (optional). Redeem the card for up to the full total,
      //    then the remainder is settled by the chosen cash/card method below.
      //    The claim-then-decrement guard mirrors services/gift-cards.ts so two
      //    concurrent redemptions can never over-draw the same balance.
      let giftCardAppliedCents = 0;
      let giftCardRemainingCents = 0;
      let giftCard: { id: string; code: string } | null = null;
      if (sale.giftCardCode) {
        const code = normalizeGiftCardCode(sale.giftCardCode);
        const card = await tx.giftCard.findFirst({
          where: { operator_id: operatorId, code },
          select: { id: true, code: true, balance_cents: true, status: true, expires_at: true },
        });
        if (!card) throw new SaleError('No gift card with that code.');
        if (card.status === 'VOID') throw new SaleError('This gift card has been voided.');
        if (card.expires_at && card.expires_at.getTime() < Date.now()) {
          throw new SaleError('This gift card has expired.');
        }
        if (card.status === 'REDEEMED' || card.balance_cents <= 0) {
          throw new SaleError('This gift card has no remaining balance.');
        }

        const applied = Math.min(card.balance_cents, pricing.totalCents);
        if (applied <= 0) throw new SaleError('This sale has no balance for the gift card to cover.');

        // Atomically claim the funds first: the decrement only lands while the card
        // still holds at least `applied`, so a concurrent redeem can't spend it twice.
        const claim = await tx.giftCard.updateMany({
          where: { id: card.id, status: { not: 'REDEEMED' }, balance_cents: { gte: applied } },
          data: { balance_cents: { decrement: applied } },
        });
        if (claim.count === 0) {
          throw new SaleError('This gift card balance changed — please re-check the card.');
        }
        giftCardAppliedCents = applied;
        giftCardRemainingCents = card.balance_cents - applied;
        giftCard = { id: card.id, code: card.code };
        if (giftCardRemainingCents <= 0) {
          await tx.giftCard.update({ where: { id: card.id }, data: { status: 'REDEEMED' } });
        }
      }

      // 5. Remainder tender validation + change. What's left after the gift card is
      //    settled by the chosen cash/card method. A gift card that fully covers the
      //    sale leaves no remainder, so no cash/card payment is taken.
      const remainderCents = pricing.totalCents - giftCardAppliedCents;
      let changeDueCents = 0;
      if (remainderCents > 0 && sale.paymentMethod === 'CASH') {
        const tendered = sale.cashTenderedCents ?? 0;
        if (tendered < remainderCents) {
          throw new SaleError('Cash tendered is less than the balance due.');
        }
        changeDueCents = tendered - remainderCents;
      }

      // 6. Resolve / create the customer for the order.
      const customerId = await resolveCustomer(tx, operatorId, sale.customer);

      // 7. Per-location, per-day order sequence (atomic within this transaction).
      //    Count orders already numbered for THIS day's prefix rather than orders
      //    whose created_at is today: seed/back-dated orders carry a calendar-day
      //    order number that differs from their created_at, so counting by
      //    created_at drifts out of sync with the encoded date and collides on the
      //    order_number unique index. Matches services/booking.ts.
      const now = new Date();
      const numberPrefix = generateOrderNumber(operator.location_code, now, 0).slice(0, -3);
      const todaysOrders = await tx.order.count({
        where: { operator_id: operatorId, order_number: { startsWith: numberPrefix } },
      });
      const orderNumber = generateOrderNumber(operator.location_code, now, todaysOrders + 1);

      const orderId = createId();

      // 7. Create the order. POS sales are paid in full at the register, so the
      //    order is COMPLETED with the full amount paid and a zero balance.
      await tx.order.create({
        data: {
          id: orderId,
          operator_id: operatorId,
          order_number: orderNumber,
          customer_id: customerId,
          status: 'COMPLETED',
          created_by: 'STAFF',
          subtotal_cents: pricing.subtotalCents,
          tax_cents: pricing.taxCents,
          processing_fee_cents: pricing.processingFeeCents,
          tip_cents: pricing.tipCents,
          discount_cents: pricing.discountCents,
          total_cents: pricing.totalCents,
          amount_paid_cents: pricing.totalCents,
          balance_due_cents: 0,
        },
      });

      // 8. Order items. Bookings reference their activity/rate/timeslot; merchandise
      //    and misc lines need a slot/rate ref per the schema, so they are persisted
      //    as a payment + order line where a booking ref exists, otherwise recorded
      //    as order events (see note below). Bookings here always have full refs.
      for (const line of resolved) {
        if (line.kind === 'BOOKING') {
          await tx.orderItem.create({
            data: {
              id: createId(),
              operator_id: operatorId,
              order_id: orderId,
              activity_id: line.activityId!,
              rate_id: line.rateId!,
              timeslot_id: line.timeslotId!,
              quantity: line.quantity,
              unit_price_cents: line.unitPriceCents,
              status: 'CHECKED_IN', // walk-ups are physically present at the dock
            },
          });
          await tx.timeslot.update({
            where: { id: line.timeslotId! },
            data: { capacity_booked: { increment: line.quantity } },
          });
        } else if (line.kind === 'MERCHANDISE' && line.merchandiseId) {
          // Decrement tracked stock; null stock is left untouched.
          await tx.merchandiseItem.updateMany({
            where: {
              id: line.merchandiseId,
              operator_id: operatorId,
              on_hand_qty: { not: null },
            },
            data: { on_hand_qty: { decrement: line.quantity } },
          });
        }
      }

      // 9. Persist merchandise/misc lines as first-class OrderMerchandiseLine rows
      //    (name/category/variant/price snapshots) — this is what the merchandise
      //    and itemized sales reports read. The OrderEvent below stays as the
      //    human-readable audit trail.
      const nonBooking = resolved.filter((l) => l.kind !== 'BOOKING');
      for (const l of nonBooking) {
        await tx.orderMerchandiseLine.create({
          data: {
            id: createId(),
            operator_id: operatorId,
            order_id: orderId,
            merchandise_id: l.merchandiseId ?? null,
            kind: l.kind === 'MERCHANDISE' ? 'MERCHANDISE' : 'MISC',
            name: l.label,
            category: l.merchCategory ?? 'Uncategorized',
            variant: l.merchVariant ?? null,
            quantity: l.quantity,
            unit_price_cents: l.unitPriceCents,
          },
        });
      }
      if (nonBooking.length > 0) {
        await tx.orderEvent.create({
          data: {
            operator_id: operatorId,
            order_id: orderId,
            type: 'POS_LINE_ITEMS',
            description: 'Register merchandise / misc lines',
            actor: auth.userId,
            metadata: {
              lines: nonBooking.map((l) => ({
                kind: l.kind,
                label: l.label,
                unitPriceCents: l.unitPriceCents,
                quantity: l.quantity,
                merchandiseId: l.merchandiseId ?? null,
              })),
            },
          },
        });
      }

      // 10. Payment(s). A gift-card tender records a GIFT_CARD payment linked to the
      //     card for the applied amount; any remainder is a second cash/card payment.
      //     The payments always sum to the order total (amount_paid = total).
      if (giftCard && giftCardAppliedCents > 0) {
        await tx.payment.create({
          data: {
            id: createId(),
            operator_id: operatorId,
            order_id: orderId,
            method: 'GIFT_CARD',
            status: 'PAID',
            amount_cents: giftCardAppliedCents,
            gift_card_id: giftCard.id,
          },
        });
        await tx.orderEvent.create({
          data: {
            operator_id: operatorId,
            order_id: orderId,
            type: 'PAYMENT',
            description: `Redeemed gift card ${giftCard.code} (${formatUSD(giftCardAppliedCents)})`,
            actor: auth.userId,
            metadata: {
              giftCardId: giftCard.id,
              appliedCents: giftCardAppliedCents,
              cardBalanceCents: giftCardRemainingCents,
            },
          },
        });
      }
      if (remainderCents > 0) {
        await tx.payment.create({
          data: {
            id: createId(),
            operator_id: operatorId,
            order_id: orderId,
            method: sale.paymentMethod === 'GIFT_CARD' ? 'CARD' : sale.paymentMethod,
            status: 'PAID',
            amount_cents: remainderCents,
            is_manually_keyed: sale.paymentMethod === 'CARD',
          },
        });
      }

      // 11. Audit event for the sale itself.
      const remainderMethod = sale.paymentMethod === 'GIFT_CARD' ? 'card' : sale.paymentMethod.toLowerCase();
      const saleTenders = [
        giftCardAppliedCents > 0 ? 'gift card' : null,
        remainderCents > 0 ? remainderMethod : null,
      ].filter(Boolean);
      await tx.orderEvent.create({
        data: {
          operator_id: operatorId,
          order_id: orderId,
          type: 'POS_SALE',
          description: `Register sale (${saleTenders.join(' + ') || 'no tender'})`,
          actor: auth.userId,
        },
      });

      // 12. Roll up customer lifetime stats.
      await tx.customer.update({
        where: { id: customerId },
        data: {
          lifetime_value_cents: { increment: pricing.totalCents },
          total_bookings: { increment: resolved.some((l) => l.kind === 'BOOKING') ? 1 : 0 },
          last_booking_at: now,
        },
      });

      return {
        orderId,
        orderNumber,
        totalCents: pricing.totalCents,
        changeDueCents,
        giftCardAppliedCents,
        giftCardRemainingCents: giftCard ? giftCardRemainingCents : 0,
      };
    });

    revalidatePath('/orders');
    revalidatePath('/manifest');
    revalidatePath('/pos');

    return {
      ok: true,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      totalCents: result.totalCents,
      changeDueCents: result.changeDueCents,
      giftCardAppliedCents: result.giftCardAppliedCents,
      giftCardRemainingCents: result.giftCardRemainingCents,
    };
  } catch (err) {
    if (err instanceof SaleError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

// --- Helpers --------------------------------------------------------------

/** A user-presentable failure inside the sale transaction (rolls the tx back). */
class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaleError';
  }
}

/**
 * Resolve the customer for a register sale. If the operator typed customer details
 * we upsert by (operator, email); otherwise we reuse/create a shared "Walk-in
 * Guest" record so anonymous register sales still attach to a valid customer.
 */
async function resolveCustomer(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  operatorId: string,
  customer: SaleInput['customer'],
): Promise<string> {
  const hasNamed = customer && customer.firstName && customer.lastName;

  if (hasNamed) {
    const email = customer!.email && customer!.email.length > 0 ? customer!.email : null;
    if (email) {
      const existing = await tx.customer.findFirst({
        where: { operator_id: operatorId, email },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    const id = createId();
    await tx.customer.create({
      data: {
        id,
        operator_id: operatorId,
        first_name: customer!.firstName,
        last_name: customer!.lastName,
        email: email ?? `${id}@register.local`,
        phone: customer!.phone ?? null,
      },
    });
    return id;
  }

  // Anonymous walk-up: one shared guest record per operator.
  const walkup = await tx.customer.findFirst({
    where: { operator_id: operatorId, email: WALKUP_EMAIL },
    select: { id: true },
  });
  if (walkup) return walkup.id;

  const id = createId();
  await tx.customer.create({
    data: {
      id,
      operator_id: operatorId,
      first_name: 'Walk-in',
      last_name: 'Guest',
      email: WALKUP_EMAIL,
    },
  });
  return id;
}
