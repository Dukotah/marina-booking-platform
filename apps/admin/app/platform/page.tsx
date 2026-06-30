import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, ExternalLink, Pencil } from 'lucide-react';
import { listOperators } from '../../lib/platform';
import { OpenClientButton } from './_components/PlatformActions';

export const metadata: Metadata = { title: 'Platform · Clients' };
export const dynamic = 'force-dynamic';

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export default async function PlatformHome() {
  const clients = await listOperators();
  const totalRevenue = clients.reduce((s, c) => s + c.revenueCents, 0);
  const webBase = process.env.NEXT_PUBLIC_WEB_BASE_URL ?? 'http://localhost:3000';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Clients</h1>
          <p className="mt-1 text-sm text-slate-400">
            {clients.length} {clients.length === 1 ? 'client' : 'clients'} · {money(totalRevenue)} booked across the platform
          </p>
        </div>
        <Link
          href="/platform/new"
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
        >
          <Plus className="h-4 w-4" aria-hidden /> New client
        </Link>
      </div>

      {clients.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 p-12 text-center text-slate-400">
          No clients yet. Create your first one to get started.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Activities</th>
                <th className="px-4 py-3 text-right font-medium">Orders</th>
                <th className="px-4 py-3 text-right font-medium">Revenue</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {clients.map((c) => (
                <tr key={c.id} className="hover:bg-slate-900/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: c.brandColor }}
                        aria-hidden
                      />
                      <div>
                        <div className="font-medium text-slate-100">{c.name}</div>
                        <div className="text-xs text-slate-500">{c.slug}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 capitalize text-slate-300">{c.plan}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        c.isActive ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
                      }`}
                    >
                      {c.isActive ? 'Active' : 'Suspended'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-300">{c.activities}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-300">{c.orders}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-100">{money(c.revenueCents)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <a
                        href={`${webBase}/?operator=${encodeURIComponent(c.slug)}`}
                        target="_blank"
                        rel="noreferrer"
                        title="View customer site"
                        className="rounded-lg border border-slate-700 p-2 text-slate-300 transition hover:bg-slate-800"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden />
                      </a>
                      <Link
                        href={`/platform/${c.id}`}
                        title="Edit client"
                        className="rounded-lg border border-slate-700 p-2 text-slate-300 transition hover:bg-slate-800"
                      >
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Link>
                      <OpenClientButton operatorId={c.id} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
