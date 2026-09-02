/**
 * Customer waiver-signing page.
 *
 * Reached after booking (or from a "sign your waiver" link in the confirmation
 * email) at `/waiver/<orderItemId>`. Renders the clause-by-clause signing UI:
 * every clause with its own initials field, a typed signature, date of birth, and
 * minor/guardian handling. Submission is blocked until all required clauses are
 * acknowledged and posts to /api/waivers/sign, which stores the immutable legal
 * snapshot.
 *
 * White-label: brand name/color drive the chrome; the waiver copy is the
 * operator's own clause text.
 */
import type { Metadata } from 'next';
import { getBrandAsync, brandStyle } from '@/lib/brand';
import SiteHeader from '@/components/layout/SiteHeader';
import SiteFooter from '@/components/layout/SiteFooter';
import { WaiverSigner } from '@/components/waiver/WaiverSigner';

export const metadata: Metadata = {
  title: 'Sign your waiver',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function WaiverPage({
  params,
  searchParams,
}: {
  params: { orderItemId: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const brand = await getBrandAsync();
  const activityId =
    typeof searchParams.activity === 'string' ? searchParams.activity : undefined;

  return (
    <div style={brandStyle(brand)} className="flex min-h-screen flex-col bg-slate-50">
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Liability waiver</h1>
          <p className="mt-1 text-sm text-slate-500">
            Please read each section, initial to acknowledge, and sign at the bottom.
          </p>
        </header>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <WaiverSigner orderItemId={params.orderItemId} activityId={activityId} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
