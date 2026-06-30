import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { NewClientForm } from '../_components/NewClientForm';

export const metadata: Metadata = { title: 'Platform · New client' };
export const dynamic = 'force-dynamic';

export default function NewClientPage() {
  return (
    <div className="space-y-6">
      <Link href="/platform" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All clients
      </Link>
      <div>
        <h1 className="text-2xl font-bold">New client</h1>
        <p className="mt-1 text-sm text-slate-400">
          Provisions an isolated account: customer site, admin dashboard, and owner login. They fill the catalog from their own onboarding.
        </p>
      </div>
      <NewClientForm />
    </div>
  );
}
