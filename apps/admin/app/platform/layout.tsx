import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { getOperatorContext } from '../../lib/session';
import { isPlatformAdmin } from '../../lib/platform';

export const dynamic = 'force-dynamic';

/**
 * Platform (super-admin) shell — deliberately distinct from the tenant admin
 * chrome (dark, "operator-of-operators" feel) so it's always obvious you're
 * above a single client. Hard-gated: non-platform identities are bounced to the
 * normal dashboard.
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const ctx = await getOperatorContext();
  if (!isPlatformAdmin(ctx.auth.userId)) {
    redirect('/');
  }
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/platform" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden />
            Platform Console
          </Link>
          <Link
            href="/"
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            Exit to my admin
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
