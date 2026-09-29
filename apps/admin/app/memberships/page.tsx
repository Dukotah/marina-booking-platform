import { redirect } from 'next/navigation';

/**
 * The memberships list moved to Catalog → Memberships when the sidebar was
 * consolidated (2026-09). /memberships/[id] detail pages still live here and
 * are NOT redirected — order pages and member records link straight to them.
 */
export default function MembershipsMovedPage(): never {
  redirect('/catalog/memberships');
}
