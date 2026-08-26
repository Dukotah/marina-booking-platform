import type { Metadata } from 'next';
import { Prisma } from '@marina/database';
import { AdminShell, PageHeader } from '../../components/shell';
import {
  AuditFilters,
  AuditPagination,
  AuditTimeline,
  CATEGORY_SUBJECTS,
  isAuditCategory,
  type AuditEntryView,
} from '../../components/audit';
import { getTenantDb, requirePermission } from '../../lib/session';
import { formatNumber } from '../../lib/format';

export const metadata: Metadata = {
  title: 'Audit log',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface AuditSearchParams {
  q?: string;
  action?: string;
  category?: string;
  from?: string;
  to?: string;
  page?: string;
}

/**
 * Audit log — the compliance timeline (docs/LOCAL-FIRST-BUILD.md §9).
 *
 * Gated on `operator:manage`, the narrowest permission that exists today. The
 * log deliberately sits above the data it describes: a staff member who can edit
 * a customer should not be able to read (or, later, prune) the record of having
 * done so. A dedicated `audit:read` permission would be the right long-term
 * home — see the note in the slice report.
 *
 * Read through the tenant client so RLS scopes it, and ordered by
 * (operator_id, created_at) — which is exactly the composite index on the table,
 * so a date-range query is a range scan rather than a sort.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<AuditSearchParams>;
}) {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const action = (params.action ?? '').trim();
  const category = (params.category ?? '').trim();
  const fromParam = (params.from ?? '').trim();
  const toParam = (params.to ?? '').trim();
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  const createdAt = dateRangeFilter(fromParam, toParam);

  const where: Prisma.AuditLogWhereInput = {
    ...(action ? { action } : {}),
    // A category is a set of action prefixes, not a stored column — see
    // components/audit/taxonomy.ts. Ignored when a specific action is chosen.
    ...(!action && isAuditCategory(category)
      ? { OR: CATEGORY_SUBJECTS[category].map((subject) => ({ action: { startsWith: `${subject}.` } })) }
      : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(query
      ? {
          AND: [
            {
              OR: [
                { actor: { contains: query, mode: 'insensitive' as const } },
                { entity_id: { contains: query, mode: 'insensitive' as const } },
                { entity_type: { contains: query, mode: 'insensitive' as const } },
              ],
            },
          ],
        }
      : {}),
  };

  // Fetch one extra row: that is how the pager knows there is an older page
  // without a COUNT(*) over an unbounded, append-only table.
  const [records, actionGroups] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
    }),
    db.auditLog.groupBy({
      by: ['action'],
      _count: { _all: true },
      orderBy: { action: 'asc' },
    }),
  ]);

  const pageRecords = records.slice(0, PAGE_SIZE);
  const actorNames = await resolveActorNames(db, pageRecords.map((r) => r.actor));

  const entries: AuditEntryView[] = pageRecords.map((row) => ({
    id: row.id,
    action: row.action,
    actor: row.actor,
    actorRole: row.actor_role,
    actorName: actorNames.get(row.actor) ?? null,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: asRecord(row.before),
    after: asRecord(row.after),
    ip: row.ip,
    createdAt: row.created_at.toISOString(),
  }));

  const actionOptions = actionGroups.map((g) => ({
    action: g.action,
    count: g._count._all,
  }));

  const totalRecorded = actionOptions.reduce((sum, o) => sum + o.count, 0);
  const isFiltered = Boolean(query || action || category || fromParam || toParam);

  return (
    <AdminShell>
      <PageHeader
        title="Audit log"
        description={
          totalRecorded === 0
            ? 'Every action that touches money or personal data is recorded here.'
            : `${formatNumber(totalRecorded)} recorded ${totalRecorded === 1 ? 'event' : 'events'} · append-only, never edited`
        }
      />
      <AuditFilters
        initialSearch={query}
        initialAction={action}
        initialCategory={isAuditCategory(category) ? category : ''}
        initialFrom={fromParam}
        initialTo={toParam}
        actionOptions={actionOptions}
      />
      <AuditTimeline entries={entries} isFiltered={isFiltered} />
      <AuditPagination page={page} pageSize={PAGE_SIZE} returned={records.length} />
    </AdminShell>
  );
}

/**
 * Turn `from`/`to` calendar days into a UTC half-open instant range. `to` is
 * inclusive of the whole day the operator picked, which is what a person means
 * by "through the 31st".
 */
function dateRangeFilter(from: string, to: string): { gte?: Date; lt?: Date } | null {
  const gte = parseDay(from);
  const toDay = parseDay(to);
  const lt = toDay ? new Date(toDay.getTime() + 24 * 60 * 60 * 1000) : null;
  if (!gte && !lt) return null;
  return { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
}

function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Map staff auth_user_ids to display names so the timeline reads "Dana Ruiz"
 * rather than a Clerk id. Actors that are not staff (a customer id, "system")
 * simply have no entry and fall back to the raw value.
 */
async function resolveActorNames(
  db: Awaited<ReturnType<typeof getTenantDb>>,
  actors: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(actors)].filter((a) => a && a !== 'system');
  if (ids.length === 0) return new Map();

  const staff = await db.staffMember.findMany({
    where: { auth_user_id: { in: ids } },
    select: { auth_user_id: true, name: true, email: true },
  });

  return new Map(staff.map((s) => [s.auth_user_id, s.name?.trim() || s.email]));
}

/** Prisma Json columns come back as JsonValue; the timeline wants a plain bag. */
function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
