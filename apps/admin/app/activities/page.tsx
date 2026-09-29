import { redirect } from 'next/navigation';

/**
 * The activities list moved to Catalog → Boats & Listings when the sidebar was
 * consolidated (2026-09). This thin page keeps every old deep link working —
 * a next.config redirect would need a dev-server restart and this doesn't.
 * /activities/[id] and /activities/new still live here and are NOT redirected.
 */
export default function ActivitiesMovedPage(): never {
  redirect('/catalog');
}
