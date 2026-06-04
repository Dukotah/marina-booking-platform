// Operator dashboard — the "dashboard-first" answer to Singenuity dumping operators
// into a raw manifest. KPIs are placeholders until the orders API lands (Phase 1).

const KPIS = [
  { label: 'Revenue today', value: '—' },
  { label: 'Revenue this week', value: '—' },
  { label: 'Occupancy', value: '—' },
  { label: 'Upcoming bookings', value: '—' },
];

const NAV = ['Dashboard', 'Manifest', 'Orders', 'Activities', 'Customers', 'POS', 'Reports', 'Settings'];

export default function DashboardPage() {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-slate-200 bg-white p-4 md:block">
        <div className="mb-6 text-lg font-bold">Marina Admin</div>
        <nav className="space-y-1">
          {NAV.map((item, i) => (
            <a
              key={item}
              href="#"
              className={`block rounded-md px-3 py-2 text-sm ${
                i === 0 ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {item}
            </a>
          ))}
        </nav>
      </aside>

      <main className="flex-1 p-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="mt-1 text-slate-500">Your business at a glance.</p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {KPIS.map((kpi) => (
            <div key={kpi.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="text-sm text-slate-500">{kpi.label}</div>
              <div className="mt-2 text-3xl font-semibold">{kpi.value}</div>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
          Visual Gantt manifest and live KPIs arrive in Phase 1 (see docs/ROADMAP.md).
        </div>
      </main>
    </div>
  );
}
