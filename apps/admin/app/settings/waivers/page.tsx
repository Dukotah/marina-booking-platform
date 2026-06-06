import { PageHeader } from '../../../components/shell';
import { getOperatorContext, currentPermissions } from '../../../lib/session';
import { apiGet, isAdminApiError } from '../../../lib/apiClient';
import {
  WaiverVersionList,
  WaiverPublishForm,
  WaiverReadOnlyNotice,
} from '../../../components/settings/WaiverTemplates';

export const dynamic = 'force-dynamic';

/** Shape returned by GET /api/waivers/templates */
interface WaiverTemplate {
  id: string;
  name: string;
  templateHtml: string;
  requiresMinorSignature: boolean;
  isActive: boolean;
  createdAt: string;
  signatureCount: number;
}

interface TemplatesResponse {
  templates: WaiverTemplate[];
}

/**
 * Waiver template management page.
 *
 * Template content is IMMUTABLE once published — a new version must be published
 * to change the legal text, and all past signatures remain linked to the version
 * they were signed against. Exactly one version is active at a time.
 *
 * Read access: order:read (all staff can view the version history).
 * Write access: operator:manage (publishing / activating requires manager tier).
 */
export default async function WaiversPage() {
  // All authenticated staff can read templates; gated actions are checked in their
  // own server actions. We resolve the permission set here to show a contextual note
  // when the user lacks operator:manage.
  await getOperatorContext(); // ensure session is valid
  const perms = await currentPermissions();
  const canManage = perms.has('operator:manage');

  let templates: WaiverTemplate[] = [];
  let fetchError: string | null = null;

  try {
    const data = await apiGet<TemplatesResponse>('/api/waivers/templates');
    templates = data.templates ?? [];
  } catch (err) {
    fetchError = isAdminApiError(err)
      ? err.message
      : 'Could not load waiver templates. Check that the API is running.';
  }

  return (
    <>
      <PageHeader
        title="Waiver Templates"
        description="Versioned legal waivers. Publishing a new version supersedes the active one; past versions are retained forever because customer signatures reference the exact text that was signed."
      />

      {!canManage && <WaiverReadOnlyNotice />}

      {fetchError ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">
          {fetchError}
        </div>
      ) : (
        <WaiverVersionList templates={templates} canManage={canManage} />
      )}

      {canManage && <WaiverPublishForm />}
    </>
  );
}
