-- Drop the foreign key from SandboxPaymentAttempt to Order.
--
-- booking.ts charges a deposit INSIDE the transaction that creates the order, so
-- when the payment simulator inserts its attempt row on a separate connection the
-- order is not committed yet and the constraint rejects it. SandboxPaymentAttempt
-- is a local testing artifact; a hard FK is not worth breaking the charge path.
-- order_id stays as an indexed soft link.
ALTER TABLE "SandboxPaymentAttempt"
  DROP CONSTRAINT IF EXISTS "SandboxPaymentAttempt_operator_id_order_id_fkey";
