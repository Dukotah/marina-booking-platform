/**
 * Browser -> API proxy for the customer portal.
 *
 * Client components fetch `/api/...` on this app's own origin rather than the API
 * directly, so calls work however the site is reached (localhost, a WSL IP, the LAN,
 * a real subdomain) with no CORS dance.
 *
 * This used to be a `rewrites()` entry in next.config.mjs, which was subtly broken:
 * a rewrite cannot add a request header, so the proxied call reached the API with no
 * `x-operator-slug`. The API's tenant middleware treats a bare `localhost` host as the
 * platform root with no tenant, so EVERY browser-side call answered
 * `400 No tenant specified` — which is why the date strip sat forever on "checking
 * availability" with every day disabled. A route handler can add the header; a rewrite
 * cannot, so this is a route handler.
 *
 * Tenant resolution mirrors the API's own order, so behaviour is identical whether a
 * request arrives here or goes straight to the API:
 *   1. a real subdomain / custom domain in the Host header wins (true multi-tenant), then
 *   2. OPERATOR_SLUG from the environment (single-tenant and local dev).
 */
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
// Node runtime: this forwards arbitrary bodies (including multipart uploads) and
// reads server-only env.
export const runtime = 'nodejs';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const BASE_DOMAIN = process.env.APP_BASE_DOMAIN ?? 'localhost:3000';
const FALLBACK_SLUG = process.env.OPERATOR_SLUG ?? 'lake-sonoma';

/**
 * The tenant for this request. Mirrors `identifierFromRequest` in the API's tenant
 * middleware: a subdomain of the base domain, or a custom domain, identifies the
 * operator; the platform root (bare `localhost` or the base domain itself) does not,
 * and falls back to the configured slug.
 */
function resolveOperatorSlug(host: string | null): string {
  if (!host) return FALLBACK_SLUG;
  const hostname = host.split(':')[0]!.toLowerCase();
  const base = BASE_DOMAIN.split(':')[0]!.toLowerCase();
  if (hostname === base || hostname === 'localhost' || hostname === '127.0.0.1') {
    return FALLBACK_SLUG;
  }
  if (hostname.endsWith(`.${base}`)) return hostname.slice(0, -1 * (base.length + 1));
  return hostname; // custom domain — the API resolves it the same way
}

/**
 * Headers that must not be copied through. Hop-by-hop headers are meaningless to the
 * upstream, and `host` must be the API's own or routing breaks. Content negotiation,
 * cookies and auth DO pass through — customer sessions ride on cookies.
 */
const STRIPPED = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'content-length', // recomputed by fetch from the body we forward
  // Critical: if we forward the browser's accept-encoding, the API answers gzipped
  // and we would hand those bytes on while dropping content-encoding below — the
  // browser then tries to JSON.parse compressed data. Ask upstream for identity and
  // let this hop's own transport do any compressing.
  'accept-encoding',
]);

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const search = req.nextUrl.search;
  const target = `${API_URL}/api/${path.map(encodeURIComponent).join('/')}${search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIPPED.has(key.toLowerCase())) headers.set(key, value);
  });
  // The whole reason this handler exists.
  headers.set('x-operator-slug', resolveOperatorSlug(req.headers.get('host')));
  // Let the API rate-limit and audit the real client, not this server.
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });

    // Pass the response through as-is, minus headers that describe a transfer we are
    // not repeating.
    const out = new Headers(upstream.headers);
    out.delete('content-encoding');
    out.delete('content-length');
    out.delete('transfer-encoding');

    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  } catch (err) {
    // The API being down is a normal local-dev state (it starts a beat after the web
    // app). Answer in the API's own error shape so callers need no special case.
    console.error(`[api-proxy] ${method} ${target} failed:`, err);
    return NextResponse.json({ error: 'The booking service is unavailable.' }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function HEAD(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
