/**
 * Browser -> API proxy for locally stored uploads (activity photos, logos).
 *
 * Photo URLs are stored RELATIVE (`/uploads/...`) so they work from whatever
 * origin the site is reached on — localhost, a WSL IP, the LAN, or a real
 * domain. This handler forwards them to the API, which serves the file from
 * `.sandbox/uploads` (see the API's routes/uploads.ts). Same pattern as the
 * `/api/[...path]` proxy, minus the tenant header: uploads are public,
 * unguessable-name-addressed, and the API route needs no slug.
 */
import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export async function GET(
  req: NextRequest,
  { params }: { params: { path: string[] } },
): Promise<NextResponse | Response> {
  const target = `${API_URL}/uploads/${params.path.map(encodeURIComponent).join('/')}`;
  const upstream = await fetch(target, {
    headers: { accept: req.headers.get('accept') ?? 'image/*' },
    cache: 'no-store',
  });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'Not found' }, { status: upstream.status || 404 });
  }
  // Pass the API's own hardened headers through (fixed image content-type,
  // restrictive CSP) rather than re-deriving them here.
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'cache-control', 'content-security-policy']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers });
}
