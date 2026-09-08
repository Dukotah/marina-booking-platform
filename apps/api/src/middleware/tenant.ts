import { createMiddleware } from 'hono/factory';
import { adminPrisma, forOperator } from '@marina/database';
import type { Env } from '../context.js';

/**
 * Resolves the tenant for the request and attaches an RLS-scoped DB client.
 *
 * Resolution order:
 *   1. `x-operator-id` header — the operator's PRIMARY KEY, for trusted server-to-server
 *      calls (admin -> API). The admin already sends this on its collect-balance,
 *      add-charge and resend-confirmation calls; without a branch that honours it, every
 *      one of those failed "No tenant specified" the moment it reached the API, because
 *      the id it sends is not a slug or a domain the resolver below matches. Validated
 *      against an active operator before it scopes anything.
 *   2. `x-operator-slug` header (dev / customer-facing server render)
 *   3. subdomain of the Host header (e.g. lake-sonoma.app-domain.com -> "lake-sonoma")
 *   4. the full Host as a custom domain (e.g. book.lakesonoma.com)
 *
 * (2)–(4) use the SECURITY DEFINER slug/domain resolver (see prisma/rls.sql) — the one
 * lookup that is intentionally allowed before a tenant scope exists. Everything
 * downstream goes through `c.var.db`, which is scoped to this operator.
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
  // Trusted server-to-server: the admin passes the operator's id directly. Resolve it by
  // PK against an active operator rather than through the slug/domain resolver, which
  // never matches an id. Kept ahead of the host/slug path so an admin call that also
  // carries a host still resolves to the id it explicitly named.
  const operatorIdHeader = c.req.header('x-operator-id')?.trim();
  if (operatorIdHeader) {
    const rows = await adminPrisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Operator" WHERE id = ${operatorIdHeader} AND is_active LIMIT 1
    `;
    const operatorId = rows[0]?.id;
    if (!operatorId) {
      return c.json({ error: 'Tenant not found' }, 404);
    }
    c.set('operatorId', operatorId);
    c.set('db', forOperator(operatorId));
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
