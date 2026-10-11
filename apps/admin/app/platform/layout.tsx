import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { getOperatorContext } from '../../lib/session';
import { isPlatformAdmin } from '../../lib/platform';
import { buttonClasses } from '../../components/ui';

export const dynamic = 'force-dynamic';

/**
 * Platform (super-admin) shell — the super-admin console that sits ABOVE a single
 * client. Clean SaaS chrome (light canvas, white surfaces, one teal accent), the
 * cooler sibling of the tenant admin. Hard-gated: non-platform identities are
 * bounced to the normal dashboard.
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const ctx = await getOperatorContext();
  if (!isPlatformAdmin(ctx.auth.userId)) {
    redirect('/');
  }
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link
            href="/platform"
            className="flex items-center gap-2 font-semibold text-ink"
          >
            <ShieldCheck className="h-5 w-5 text-accent" aria-hidden />
            Platform Console
          </Link>
          <Link href="/" className={buttonClasses('secondary', 'sm')}>
            Exit to my admin
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
