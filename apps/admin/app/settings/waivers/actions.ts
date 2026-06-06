'use server';

import { revalidatePath } from 'next/cache';
import { ROLE_PERMISSIONS } from '@marina/auth';
import { apiPost, isAdminApiError } from '../../../lib/apiClient';
import { getOperatorContext } from '../../../lib/session';
import type { Permission } from '@marina/auth';

/**
 * Server actions for waiver template management.
 *
 * All mutations require the `operator:manage` permission — the same tier the
 * API enforces on POST /api/waivers/templates and POST /api/waivers/templates/:id/activate.
 *
 * We call the API (not the DB directly) because the waiver template endpoints
 * are the single source of truth for versioning + activation atomics.
 */

export interface WaiverActionResult {
  ok: boolean;
  error?: string;
}

/** Check permission before hitting the API to return a friendly error early. */
async function checkManagePermission(): Promise<{ ok: false; error: string } | null> {
  const ctx = await getOperatorContext();
  const perms = new Set<Permission>([
    ...ROLE_PERMISSIONS[ctx.auth.role],
    ...ctx.auth.extraPermissions,
  ]);
  if (!perms.has('operator:manage')) {
    return { ok: false, error: 'You need manager access to publish or activate waiver templates.' };
  }
  return null;
}

/**
 * Publish a new waiver template version. When `activate` is true (default) the
 * new version immediately becomes the active one and the prior version is
 * deactivated — all in a single API transaction.
 */
export async function publishWaiverVersion(formData: FormData): Promise<WaiverActionResult> {
  const denied = await checkManagePermission();
  if (denied) return denied;

  const name = (formData.get('name') as string | null)?.trim() ?? '';
  const templateHtml = (formData.get('templateHtml') as string | null)?.trim() ?? '';
  const requiresMinorSignature = formData.get('requiresMinorSignature') !== 'false';
  const activate = formData.get('activate') !== 'false';

  if (!name) return { ok: false, error: 'Template name is required.' };
  if (!templateHtml) return { ok: false, error: 'Template HTML is required.' };

  try {
    await apiPost('/api/waivers/templates', {
      name,
      templateHtml,
      requiresMinorSignature,
      activate,
    });
    revalidatePath('/settings/waivers');
    return { ok: true };
  } catch (err) {
    if (isAdminApiError(err)) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'Could not publish the waiver version. Please try again.' };
  }
}

/**
 * Activate an existing waiver template version. Deactivates all other versions
 * in a single API transaction so exactly one version is active at a time.
 */
export async function activateWaiverVersion(templateId: string): Promise<WaiverActionResult> {
  const denied = await checkManagePermission();
  if (denied) return denied;

  if (!templateId) return { ok: false, error: 'Missing template ID.' };

  try {
    await apiPost(`/api/waivers/templates/${templateId}/activate`);
    revalidatePath('/settings/waivers');
    return { ok: true };
  } catch (err) {
    if (isAdminApiError(err)) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'Could not activate this version. Please try again.' };
  }
}
