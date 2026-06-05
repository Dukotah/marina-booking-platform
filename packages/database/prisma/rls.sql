-- Row-Level Security — the DB-level backstop for tenant isolation.
-- See docs/ARCHITECTURE.md § Tenant Isolation and docs/DECISIONS.md D-004.
--
-- Every tenant table is FORCE-enabled for RLS and gated by a single policy:
-- a row is visible/writable only when its operator_id equals the per-transaction
-- session GUC `app.current_operator_id`. The tenant client (src/client.ts) sets
-- that GUC with SET LOCAL inside each query's transaction, so even a query that
-- forgets its WHERE clause cannot cross tenants. current_setting(..., true)
-- returns NULL when unset, so an unscoped connection sees nothing (fail closed).
--
-- This script is idempotent — safe to re-run after every migration.

-- Operator is keyed by id (it IS the tenant), not operator_id.
ALTER TABLE "Operator" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Operator" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Operator";
CREATE POLICY tenant_isolation ON "Operator"
  USING (id = current_setting('app.current_operator_id', true))
  WITH CHECK (id = current_setting('app.current_operator_id', true));

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'Location', 'StaffMember', 'Activity', 'Rate', 'Timeslot', 'Resource',
    'Customer', 'Order', 'OrderItem', 'Payment', 'Note', 'OrderEvent',
    'Fee', 'MerchandiseItem', 'PromoCode', 'Waiver', 'WaiverSignature',
    'Integration', 'GiftCard', 'GiftCardTransaction'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (operator_id = current_setting(''app.current_operator_id'', true)) '
      'WITH CHECK (operator_id = current_setting(''app.current_operator_id'', true));',
      t
    );
  END LOOP;
END $$;

-- StaffLocation is a join table with no operator_id; it is reachable only through
-- already-scoped parents and is protected at the application layer.

-- Tenant resolution bootstrap: mapping a hostname/slug to an operator id must work
-- BEFORE any tenant scope is set (you can't scope to a tenant you haven't resolved
-- yet). This SECURITY DEFINER function runs as the table owner, so it can read the
-- directory while every other access path stays under RLS. It exposes only the id —
-- nothing sensitive — for a given active slug or custom domain.
CREATE OR REPLACE FUNCTION public.resolve_operator_id(identifier text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT id FROM "Operator"
  WHERE is_active AND (slug = identifier OR custom_domain = identifier)
  LIMIT 1;
$$;
