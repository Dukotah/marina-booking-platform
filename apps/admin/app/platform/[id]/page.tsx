import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getOperatorById } from '../../../lib/platform';
import { EditClientForm } from '../_components/EditClientForm';
import { OpenClientButton } from '../_components/PlatformActions';

export const metadata: Metadata = { title: 'Platform · Edit client' };
export const dynamic = 'force-dynamic';

export default async function EditClientPage({ params }: { params: { id: string } }) {
  const op = await getOperatorById(params.id);
  if (!op) notFound();

  return (
    <div className="space-y-6">
      <Link href="/platform" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All clients
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{op.name_external}</h1>
          <p className="mt-1 text-sm text-slate-400">{op.slug}</p>
        </div>
        <OpenClientButton operatorId={op.id} />
      </div>
      <EditClientForm
        values={{
          id: op.id,
          slug: op.slug,
          name_external: op.name_external,
          name_internal: op.name_internal,
          brand_color: op.brand_color,
          website: op.website ?? '',
          phone: op.phone ?? '',
          timezone: op.timezone,
          legal_adult_age: op.legal_adult_age,
          plan: op.plan,
          is_active: op.is_active,
        }}
      />
    </div>
  );
}
