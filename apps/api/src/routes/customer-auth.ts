/**
 * Customer magic-link auth API.
 *
 *   POST /request       public — ask for a sign-in link (always the same reply)
 *   POST /redeem        public — exchange a link token for a customer session
 *   POST /logout        public — clear the session cookie
 *   GET  /me            session — who is signed in
 *   GET  /me/bookings   session — EVERY order belonging to that customer, only theirs
 *
 * This replaces the order-number + email lookup the portal shipped with. The
 * important difference is `/me/bookings`: the session carries a customer id, so
 * the list is filtered by `customer_id` server-side and a signed-in customer
 * cannot widen it. The old flow could only ever return the single order whose
 * number you already knew.
 *
 * All data access goes through `c.var.db`, the RLS-scoped tenant client, and
 * every session is additionally checked against `c.var.operatorId` — a session
 * minted on one tenant is not a session on another even though both are signed
 * with the same platform key.
 *
 * NOT MOUNTED YET: `app.ts` is owned by another agent this run. See the handoff
 * report for the one line it needs.
 */
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Prisma } from '@marina/database';
import type { Env } from '../context.js';
import { getClientIp, rateLimit } from '../middleware/rate-limit.js';
import {
  CUSTOMER_SESSION_COOKIE,
  type CustomerSession,
  emailRequestLimiter,
  linkTtlSeconds,
  redeemMagicLink,
  requestMagicLink,
  verifyCustomerSession,
} from '../services/customer-auth.js';

export const customerAuth = new Hono<Env>();

/**
 * Per-IP budgets, following the pattern in routes/orders.ts. Tighter than the
 * public default (30/min): asking for a sign-in link and presenting a token are
 * both things a legitimate human does a handful of times, and both are what an
 * attacker would want to do thousands of times.
 *
 * The per-MAILBOX budget is separate and lives in the service — an IP limit alone
 * does nothing against a distributed mailbomb aimed at one address.
 */
const requestLimit = rateLimit({ windowMs: 60_000, max: 6, bucket: 'customer-auth:request' });
const redeemLimit = rateLimit({ windowMs: 60_000, max: 20, bucket: 'customer-auth:redeem' });

/**
 * The ONE body the request endpoint ever returns. Written once, at module scope,
 * so no future edit can accidentally make a branch distinguishable — that
 * indistinguishability is the entire privacy property of this endpoint.
 */
const REQUEST_ACCEPTED = {
  ok: true,
  message:
    'If that email address has a booking with us, a sign-in link is on its way. ' +
    'Check your inbox — the link expires shortly.',
} as const;

const isProd = process.env.NODE_ENV === 'production';

/** Session cookie options. `Lax` (not `Strict`) because the customer arrives by
 *  clicking a link in their mail client, which is a cross-site navigation. */
function sessionCookieOptions(expiresAt: Date) {
  const domain = process.env.CUSTOMER_SESSION_COOKIE_DOMAIN?.trim();
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'Lax' as const,
    path: '/',
    expires: expiresAt,
    ...(domain ? { domain } : {}),
  };
}

// --- POST /request : ask for a link ---------------------------------------

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

customerAuth.post('/request', requestLimit, async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  // Even a malformed body gets the standard answer. A 422 here would say "that
  // was a real address, it just isn't ours" versus "that isn't an address" — a
  // distinction worth nothing to a customer and something to an enumerator.
  if (!parsed.success) return c.json(REQUEST_ACCEPTED);

  const email = parsed.data.email;
  const ip = getClientIp((name) => c.req.header(name));

  // Per-mailbox budget, scoped by tenant so one operator's traffic cannot
  // exhaust another's budget for the same address.
  const decision = emailRequestLimiter.take(`${c.var.operatorId}::${email}`);
  if (!decision.allowed) {
    // Still the same body — a 429 keyed on the address would itself confirm the
    // address exists. The header is enough for a well-behaved client.
    c.header('Retry-After', String(decision.retryAfterSeconds));
    return c.json(REQUEST_ACCEPTED);
  }

  try {
    const result = await requestMagicLink({
      db: c.var.db,
      operatorId: c.var.operatorId,
      email,
      ip,
    });
    if (!result.delivered) {
      // Diagnostic only. Never reaches the response.
      console.info(`[customer-auth] no link sent (${result.reason ?? 'unknown'})`);
    }
  } catch (err) {
    // A failure here must not become a 500: an error status is a side channel
    // that says "this branch did more work", i.e. the address existed.
    console.error('[customer-auth] request failed:', err);
  }

  return c.json(REQUEST_ACCEPTED);
});

// --- POST /redeem : exchange a token for a session ------------------------

const redeemSchema = z.object({
  token: z.string().min(1).max(512),
});

/** One message for every failure mode. Which one it was is only useful to
 *  someone probing; the customer's next step is identical either way. */
const REDEEM_FAILED = {
  error: 'That sign-in link is no longer valid. Please request a new one.',
  code: 'INVALID_LINK',
} as const;

customerAuth.post('/redeem', redeemLimit, async (c) => {
  const parsed = redeemSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(REDEEM_FAILED, 400);

  const result = await redeemMagicLink({
    db: c.var.db,
    operatorId: c.var.operatorId,
    token: parsed.data.token,
  });
  if (!result.ok) {
    console.info(`[customer-auth] redeem rejected (${result.reason})`);
    return c.json(REDEEM_FAILED, 400);
  }

  setCookie(
    c,
    CUSTOMER_SESSION_COOKIE,
    result.session.token,
    sessionCookieOptions(result.session.expiresAt),
  );

  // The token is also returned in the body: the portal's magic-link page runs
  // server-side on a different origin and sets its OWN cookie, which is what
  // makes the session work when the API lives on api.example.com.
  return c.json({
    session: {
      token: result.session.token,
      expiresAt: result.session.expiresAt,
    },
    customer: result.customer,
    bookings: await listCustomerBookings(c.var.db, result.customer.id),
  });
});

// --- POST /logout ---------------------------------------------------------

customerAuth.post('/logout', (c) => {
  const domain = process.env.CUSTOMER_SESSION_COOKIE_DOMAIN?.trim();
  deleteCookie(c, CUSTOMER_SESSION_COOKIE, { path: '/', ...(domain ? { domain } : {}) });
  return c.json({ ok: true });
});

// --- Session resolution ---------------------------------------------------

/**
 * Resolve the signed-in customer for this request, or null.
 *
 * Accepts the cookie (browser, same site) or a bearer token (the portal's server
 * components, which hold the cookie themselves and forward it). The tenant check
 * is not optional: without it a session issued by operator A would authenticate
 * against operator B's RLS scope, and `customer_id` would silently match nothing
 * — or worse, match.
 */
function currentCustomer(c: Context<Env>): CustomerSession | null {
  const header = c.req.header('authorization');
  const bearer = header?.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : undefined;
  const session = verifyCustomerSession(bearer ?? getCookie(c, CUSTOMER_SESSION_COOKIE));
  if (!session) return null;
  return session.operatorId === c.var.operatorId ? session : null;
}

const UNAUTHENTICATED = {
  error: 'Please sign in to view your bookings.',
  code: 'NOT_SIGNED_IN',
} as const;

// --- GET /me --------------------------------------------------------------

customerAuth.get('/me', async (c) => {
  const session = currentCustomer(c);
  if (!session) return c.json(UNAUTHENTICATED, 401);

  const customer = await c.var.db.customer.findUnique({
    where: { id: session.customerId },
    select: { id: true, first_name: true, last_name: true, email: true, phone: true },
  });
  if (!customer) return c.json(UNAUTHENTICATED, 401);

  return c.json({
    customer: {
      id: customer.id,
      firstName: customer.first_name,
      lastName: customer.last_name,
      email: customer.email,
      phone: customer.phone,
    },
    expiresAt: session.expiresAt,
    linkTtlSeconds: linkTtlSeconds(),
  });
});

// --- GET /me/bookings -----------------------------------------------------

type PortalOrder = Prisma.OrderGetPayload<{
  include: { items: { include: { activity: true; rate: true; timeslot: true } } };
}>;

/**
 * Every order for one customer, newest first.
 *
 * `customer_id` is applied here and nowhere else — there is no query parameter a
 * caller could use to widen it. RLS already fences the tenant; this fences the
 * person inside it.
 */
async function listCustomerBookings(db: Env['Variables']['db'], customerId: string) {
  const rows = (await db.order.findMany({
    where: { customer_id: customerId },
    orderBy: { created_at: 'desc' },
    take: 100,
    include: { items: { include: { activity: true, rate: true, timeslot: true } } },
  })) as PortalOrder[];

  return rows.map((order) => {
    // The trip date a customer thinks of as "the booking" is the earliest slot
    // on it; a multi-item order still reads as one reservation in the portal.
    const startsAt = order.items.reduce<Date | null>((earliest, item) => {
      const at = item.timeslot.datetime;
      return !earliest || at < earliest ? at : earliest;
    }, null);

    return {
      orderNumber: order.order_number,
      status: order.status,
      startsAt,
      totalCents: order.total_cents,
      balanceDueCents: order.balance_due_cents,
      createdAt: order.created_at,
      items: order.items.map((item) => ({
        id: item.id,
        activityName: item.activity.name_external,
        rateName: item.rate.name_external,
        quantity: item.quantity,
        status: item.status,
        startsAt: item.timeslot.datetime,
      })),
    };
  });
}

customerAuth.get('/me/bookings', async (c) => {
  const session = currentCustomer(c);
  if (!session) return c.json(UNAUTHENTICATED, 401);
  return c.json({ bookings: await listCustomerBookings(c.var.db, session.customerId) });
});
