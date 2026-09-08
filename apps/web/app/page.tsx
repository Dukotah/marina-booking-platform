/**
 * Customer home page — availability-first (DESIGN.md "Speed mechanics").
 *
 * Leads with the "Today's Departures" board: a 7-day rail + the day's next
 * bookable timeslots with all-in prices and a Reserve action, so the first
 * bookable thing is on screen before any browsing. Below it, a compact Estate
 * catalog (small photo cards) for guests who want to browse the whole fleet.
 *
 * Server component: the board day comes from `?date=` (plain links on the
 * rail), the data from the tenant-scoped departures endpoint. In DEMO_MODE the
 * board API doesn't exist, so the page degrades to the catalog-led layout.
 * Graceful error and empty states keep the route from ever appearing broken.
 *
 * All branding is resolved from operator/tenant data (lib/brand) — never
 * hardcoded. Money is integer cents, formatted via the shared helper.
 */
import {
  getCatalog,
  getDepartures,
  isApiError,
  type CatalogActivity,
  type DeparturesBoard as BoardData,
} from '@/lib/api';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { brandStyle, getBrandAsync } from '@/lib/brand';
import { CatalogHero } from '@/components/catalog/CatalogHero';
import { CatalogBrowser } from '@/components/catalog/CatalogBrowser';
import { CatalogNotice } from '@/components/catalog/CatalogNotice';
import { DeparturesBoard } from '@/components/home/DeparturesBoard';

// Availability shifts continuously; keep the board fresh per request.
export const dynamic = 'force-dynamic';

interface HomePageProps {
  searchParams: { date?: string };
}

export default async function HomePage({ searchParams }: HomePageProps) {
  let activities: CatalogActivity[] = [];
  let loadFailed = false;
  let board: BoardData | null = null;
  let boardFailed = false;

  const brand = await getBrandAsync();

  // The rail links pass ?date=YYYY-MM-DD; anything malformed falls back to today.
  const dateParam = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date ?? '')
    ? searchParams.date
    : undefined;

  const [catalogResult, boardResult] = await Promise.allSettled([
    getCatalog(),
    getDepartures(dateParam),
  ]);

  if (catalogResult.status === 'fulfilled') {
    activities = catalogResult.value;
  } else {
    // Network or non-2xx from the API. A missing-tenant style 404 is treated the
    // same as any other failure here — the customer just sees a friendly notice.
    loadFailed = true;
    if (!isApiError(catalogResult.reason)) {
      console.error('Unexpected catalog load error:', catalogResult.reason);
    }
  }

  if (boardResult.status === 'fulfilled') {
    board = boardResult.value; // null in DEMO_MODE — board section simply hidden
  } else {
    boardFailed = true;
    if (!isApiError(boardResult.reason)) {
      console.error('Unexpected departures load error:', boardResult.reason);
    }
  }

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col">
      <SiteHeader />

      <main id="main-content" tabIndex={-1} className="flex-1">
        <CatalogHero activityCount={loadFailed ? 0 : activities.length} brand={brand} />

        <div className="mx-auto max-w-[1120px] px-6 pb-24">
          {/* The board leads; browsing follows. Sections breathe (64–96px). */}
          {board && (
            <div className="pt-8">
              <DeparturesBoard board={board} selectedDate={board.date} />
            </div>
          )}
          {boardFailed && (
            /* Error state in plain words; the catalog below still works. */
            <div className="mt-8 rounded-card border border-hairline bg-surface px-6 py-10 text-center shadow-card">
              <p className="text-base text-ink">We couldn&apos;t load the departure times.</p>
              <p className="mt-1 text-sm text-muted">
                Refresh in a moment, or browse the fleet below and pick a time there.
              </p>
            </div>
          )}

          <div className="pt-16 sm:pt-24">
            {board && (
              <h2 className="mb-8 font-display text-[22px] tracking-[0.02em] text-ink">
                Browse the fleet
              </h2>
            )}
            {loadFailed ? (
              <CatalogNotice variant="error" />
            ) : activities.length === 0 ? (
              <CatalogNotice variant="empty" />
            ) : (
              <CatalogBrowser activities={activities} contactPhone={brand.phone} />
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
