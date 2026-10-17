import { PageHeader } from '../../../components/shell';
import { getTenantDb, requirePermission } from '../../../lib/session';
import {
  MessageTemplatesManager,
  type MessageTemplateRow,
} from '../../../components/settings/MessageTemplatesManager';

export const dynamic = 'force-dynamic';

/**
 * Message templates. Tenant-scoped via getTenantDb (RLS), gated on operator:manage.
 * Operator overrides for the automatic transactional guest messages — one row per
 * MessageTemplateKind. The notifications service uses the override fields when present
 * (and enabled) and falls back to the built-in default copy for any blank field.
 */
export default async function MessageTemplatesPage() {
  await requirePermission('operator:manage');
  const db = await getTenantDb();

  const templates = await db.messageTemplate.findMany({
    orderBy: { created_at: 'asc' },
    select: {
      id: true,
      kind: true,
      enabled: true,
      subject_override: true,
      body_override: true,
      sms_body_override: true,
    },
  });

  const rows: MessageTemplateRow[] = templates.map((t) => ({
    id: t.id,
    kind: t.kind,
    enabled: t.enabled,
    subjectOverride: t.subject_override,
    bodyOverride: t.body_override,
    smsBodyOverride: t.sms_body_override,
  }));

  return (
    <>
      <PageHeader
        title="Message Templates"
        description="Customise the automatic guest messages, or leave them on the built-in defaults."
      />
      <MessageTemplatesManager templates={rows} />
    </>
  );
}
