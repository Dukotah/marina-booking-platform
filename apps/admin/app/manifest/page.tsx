import { CommandCenter } from './CommandCenter';

export const dynamic = 'force-dynamic';

interface ManifestPageProps {
  searchParams: { date?: string };
}

/**
 * Day manifest — the visual, Gantt-style answer to Singenuity's text-wall manifest.
 * Shares its body with the home page (`/`) via CommandCenter; kept as its own route
 * so existing deep links (`/manifest?date=…`) keep working. Here it reads as the
 * "Manifest" surface rather than "Today".
 */
export default async function ManifestPage({ searchParams }: ManifestPageProps) {
  return <CommandCenter date={searchParams.date} />;
}
