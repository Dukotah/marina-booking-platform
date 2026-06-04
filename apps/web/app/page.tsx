/**
 * Customer catalog / home page for the booking portal.
 *
 * Server component: fetches the tenant's bookable catalog, renders a white-label
 * hero (operator brand), and hands the activity list to a client browser that
 * does instant search + category/capacity/price filtering. Header and footer are
 * rendered here so the page is a complete, self-contained shell. Graceful error
 * and empty states keep the route from ever appearing broken.
 *
 * All branding is resolved from operator/tenant data (lib/brand) — never
 * hardcoded. Money is integer cents, formatted via the shared helper.
 */
import { getCatalog, isApiError, type CatalogActivity } from '@/lib/api';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { brandStyle } from '@/lib/brand';
import { CatalogHero } from '@/components/catalog/CatalogHero';
import { CatalogBrowser } from '@/components/catalog/CatalogBrowser';
import { CatalogNotice } from '@/components/catalog/CatalogNotice';

// Availability shifts continuously; keep the catalog fresh per request.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let activities: CatalogActivity[] = [];
  let loadFailed = false;

  try {
    activities = await getCatalog();
  } catch (err) {
    // Network or non-2xx from the API. A missing-tenant style 404 is treated the
    // same as any other failure here — the customer just sees a friendly notice.
    loadFailed = true;
    if (!isApiError(err)) {
      // Re-surface truly unexpected (non-API) errors during development.
      console.error('Unexpected catalog load error:', err);
    }
  }

  return (
    <div style={brandStyle()} className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        <CatalogHero activityCount={loadFailed ? 0 : activities.length} />

        <div className="mx-auto max-w-6xl px-4 py-10 sm:py-12">
          {loadFailed ? (
            <CatalogNotice variant="error" />
          ) : activities.length === 0 ? (
            <CatalogNotice variant="empty" />
          ) : (
            <CatalogBrowser activities={activities} />
          )}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
