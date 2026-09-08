/**
 * Same-origin proxy for the per-booking .ics download.
 *
 * The confirmation page links to `/calendar/booking/<orderItemId>.ics` on THIS
 * app's origin rather than the API directly, for the same reason browser API
 * calls go through `app/api/[...path]/route.ts`: the API's own host
 * (localhost:3001 in dev) is not necessarily reachable from the visitor's
 * browser (WSL / LAN / remote preview). The API route lives outside the tenant
 * middleware (the unguessable order-item id names the operator), so no tenant
 * header is needed here — just a straight server-side fetch.
 */
import { type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export async function GET(
  _req: NextRequest,
  { params }: { params: { itemId: string } | Promise<{ itemId: string }> },
) {
  const { itemId } = await Promise.resolve(params);
  // The id arrives with its .ics suffix intact; the API accepts both forms.
  // Keep the path tight — one encoded segment, nothing traversable.
  const upstream = await fetch(
    `${API_URL}/calendar/booking/${encodeURIComponent(itemId)}`,
    { cache: 'no-store' },
  ).catch(() => null);

  if (!upstream || !upstream.ok) {
    return new Response('Calendar file unavailable', { status: upstream?.status ?? 502 });
  }

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'text/calendar; charset=utf-8',
      'content-disposition':
        upstream.headers.get('content-disposition') ?? 'attachment; filename="booking.ics"',
      'cache-control': 'private, max-age=300',
    },
  });
}
