import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import { INTEGRATION_CATALOG, type IntegrationDef } from '../../../components/settings/integrationCatalog';
import { IntegrationCard, type IntegrationState } from '../../../components/settings/IntegrationCard';

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
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
              {category}
            </h2>
            <div className="space-y-4">
              {INTEGRATION_CATALOG.filter((d) => d.category === category).map((def) => (
                <IntegrationCard key={def.key} def={def} initial={initialFor(def)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
