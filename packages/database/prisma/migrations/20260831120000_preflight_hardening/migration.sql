-- Preflight hardening (2026-08-31): reminder idempotency + integrity backstops.

-- At most one pre-arrival reminder event per order (makes the claim-first sweep
-- concurrency-safe: a second concurrent cron loses this insert with P2002 and skips).
CREATE UNIQUE INDEX "OrderEvent_one_reminder_per_order"
  ON "OrderEvent" ("operator_id", "order_id") WHERE "type" = 'REMINDER_SENT';

-- Defense-in-depth behind the application-level guards.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_refunded_within_amount" CHECK ("refunded_cents" <= "amount_cents");
ALTER TABLE "MerchandiseItem"
  ADD CONSTRAINT "MerchandiseItem_stock_nonneg" CHECK ("on_hand_qty" IS NULL OR "on_hand_qty" >= 0);
ALTER TABLE "GiftCard"
  ADD CONSTRAINT "GiftCard_balance_nonneg" CHECK ("balance_cents" >= 0);
ALTER TABLE "PromoCode"
  ADD CONSTRAINT "PromoCode_redemptions_within_cap"
  CHECK ("max_redemptions" IS NULL OR "times_redeemed" <= "max_redemptions");
