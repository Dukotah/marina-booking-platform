import { formatUSD } from '@marina/types';
import { getCatalog, type CatalogActivity } from '@/lib/api';

export default async function HomePage() {
  let activities: CatalogActivity[] = [];
  let error: string | null = null;
  try {
    activities = await getCatalog();
  } catch {
    error =
      'Catalog is not available yet. Connect the database (see docs/ROADMAP.md), run migrate + seed, and start the API.';
  }

  const categories = Array.from(new Set(activities.map((a) => a.category)));

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Book Your Adventure</h1>
        <p className="mt-1 text-slate-600">Boats, watercraft, and waterfront venues.</p>
      </header>

      {error && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-800">
          {error}
        </div>
      )}

      {!error && categories.map((cat) => (
        <section key={cat} className="mb-10">
          <h2 className="mb-4 text-xl font-semibold capitalize">{cat.toLowerCase()}</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activities
              .filter((a) => a.category === cat)
              .map((a) => (
                <article
                  key={a.id}
                  className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md"
                >
                  <div className="h-2" style={{ backgroundColor: a.color }} />
                  <div className="p-4">
                    <h3 className="font-medium">{a.name}</h3>
                    <p className="mt-1 text-sm text-slate-500">Up to {a.maxParticipants} guests</p>
                    <p className="mt-3 font-semibold text-brand">
                      {a.fromPriceCents != null ? `from ${formatUSD(a.fromPriceCents)}` : 'Pricing TBD'}
                    </p>
                  </div>
                </article>
              ))}
          </div>
        </section>
      ))}
    </main>
  );
}
