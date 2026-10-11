import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { INTEGRATION_CATALOG, type IntegrationDef } from '../../../components/settings/integrationCatalog';
import { IntegrationCard, type IntegrationState } from '../../../components/settings/IntegrationCard';
import { CalendarFeedCard } from '../../../components/settings/CalendarFeedCard';

/**
 * Public base URL of the API — what external calendar services will poll for the
 * ICS feed. Mirrors the fallback chain the rest of the admin app uses for
 * server-side API calls, with the local dev default last.
 */
function apiPublicBaseUrl(): string {
  return (
    process.env.API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    process.env.API_URL ??
    'http://localhost:3001'
  ).replace(/\/+$/, '');
}

export const dynamic = 'force-dynamic';

/** Coerce a stored config JSON value into the string map the cards expect. */
function toStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * Integrations. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Loads stored Integration records and pairs them with the catalog so each card
 * is prefilled. Records are upserted by key on save. Integrations are config
 * records (not hard-coded), so new ones are added by extending the catalog.
 */
export default async function IntegrationsPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const stored = await db.integration.findMany({
    select: { key: true, enabled: true, config: true },
  });
  const byKey = new Map(stored.map((i) => [i.key, i]));

  const initialFor = (def: IntegrationDef): IntegrationState => {
    const row = byKey.get(def.key);
    return {
      enabled: row?.enabled ?? false,
      config: toStringMap(row?.config),
    };
  };

  // Group catalog entries by category for a scannable layout.
  const categories = [...new Set(INTEGRATION_CATALOG.map((d) => d.category))];

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect payments, accounting, marketing, and messaging. Keys are stored per-tenant."
      />
      <div className="space-y-8">
        {categories.map((category) => (
          <div key={category}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
              {category}
            </h2>
            <div className="space-y-4">
              {INTEGRATION_CATALOG.filter((d) => d.category === category).map((def) => {
                // The calendar feed's credential is a server-generated token, not
                // typed-in keys — it gets its own generate/rotate card.
                if (def.key === 'calendar_feed') {
                  const row = byKey.get(def.key);
                  const config = toStringMap(row?.config);
                  return (
                    <CalendarFeedCard
                      key={def.key}
                      def={def}
                      initialToken={config.token ?? null}
                      initialEnabled={row?.enabled ?? false}
                      apiBaseUrl={apiPublicBaseUrl()}
                    />
                  );
                }
                return <IntegrationCard key={def.key} def={def} initial={initialFor(def)} />;
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
