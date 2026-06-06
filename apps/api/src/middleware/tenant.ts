import { createMiddleware } from 'hono/factory';
import { adminPrisma, forOperator } from '@marina/database';
import type { Env } from '../context.js';

/**
 * Resolves the tenant for the request and attaches an RLS-scoped DB client.
 *
 * Resolution order:
 *   0. `x-operator-id` header — a trusted server-to-server caller (e.g. the admin
 *      app, D-029) passing the operator id directly. VALIDATED against an active
 *      Operator before it is trusted; an unknown/inactive id is rejected, never
 *      scoped. Same trust model as the slug header (both are internal-caller inputs;
 *      public browser traffic resolves by Host).
 *   1. `x-operator-slug` header (dev / server-to-server convenience)
 *   2. subdomain of the Host header (e.g. lake-sonoma.app-domain.com -> "lake-sonoma")
 *   3. the full Host as a custom domain (e.g. book.lakesonoma.com)
 *
 * Uses the SECURITY DEFINER resolver (see prisma/rls.sql) — the one lookup that is
 * intentionally allowed before a tenant scope exists. Everything downstream goes
 * through `c.var.db`, which is scoped to this operator.
 */
const BASE_DOMAIN = process.env.APP_BASE_DOMAIN ?? 'localhost:3000';

function identifierFromRequest(host: string | undefined, slugHeader: string | undefined): string | null {
  if (slugHeader) return slugHeader.trim().toLowerCase();
  if (!host) return null;
  const hostname = host.split(':')[0]!.toLowerCase();
  const base = BASE_DOMAIN.split(':')[0]!.toLowerCase();
  if (hostname === base || hostname === 'localhost') return null; // platform root, no tenant
  if (hostname.endsWith(`.${base}`)) {
    return hostname.slice(0, -1 * (base.length + 1)); // the subdomain
  }
  return hostname; // treat as a custom domain
}

export const tenantMiddleware = createMiddleware<Env>(async (c, next) => {
  // Trusted server-to-server callers may pass the operator id directly. Validate it
  // against an active Operator before scoping — never trust an arbitrary string to
  // set the RLS GUC.
  const directId = c.req.header('x-operator-id')?.trim();
  if (directId) {
    const found = await adminPrisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Operator" WHERE is_active AND id = ${directId} LIMIT 1
    `;
    const opId = found[0]?.id;
    if (!opId) {
      return c.json({ error: 'Tenant not found' }, 404);
    }
    c.set('operatorId', opId);
    c.set('db', forOperator(opId));
    await next();
    return;
  }

  const identifier = identifierFromRequest(c.req.header('host'), c.req.header('x-operator-slug'));
  if (!identifier) {
    return c.json({ error: 'No tenant specified' }, 400);
  }

  const rows = await adminPrisma.$queryRaw<{ id: string | null }[]>`
    SELECT public.resolve_operator_id(${identifier}) AS id
  `;
  const operatorId = rows[0]?.id;
  if (!operatorId) {
    return c.json({ error: 'Tenant not found' }, 404);
  }

  c.set('operatorId', operatorId);
  c.set('db', forOperator(operatorId));
  await next();
});
