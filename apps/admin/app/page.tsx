// Home is the work, not a BI dashboard. `/` renders the manifest's operational
// command center for today — the same surface as `/manifest` — so staff land
// directly on the day's departures, check-ins, and returns. The brand logo links
// here, so a logo tap always returns to "Today". Revenue/occupancy BI moved out
// of the landing path; the reporting surfaces still live under /reports.

import { CommandCenter } from './manifest/CommandCenter';

export const dynamic = 'force-dynamic';

interface HomePageProps {
  searchParams: { date?: string };
}

export default async function HomePage({ searchParams }: HomePageProps) {
  return <CommandCenter date={searchParams.date} home />;
}
