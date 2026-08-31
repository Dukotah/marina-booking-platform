import { redirect } from 'next/navigation';

// The dashboard lives at "/". This alias exists so a typed or bookmarked
// "/dashboard" lands on it instead of dead-ending on a 404.
export const dynamic = 'force-dynamic';

export default function DashboardAlias() {
  redirect('/');
}
