'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '../../lib/session';
import { apiPost, apiPatch, apiDelete, isAdminApiError } from '../../lib/apiClient';

/**
 * Server actions for the resources slice. All writes go through the API client
 * (D-029) so the API remains the single source of truth for shared-asset
 * capacity logic. Each action requires `activity:write`.
 */

export interface ResourceActionResult {
  ok: true;
  resourceId?: string;
}
export interface ResourceActionError {
  ok: false;
  error: string;
}
export type ResourceResult = ResourceActionResult | ResourceActionError;

// ---------------------------------------------------------------------------
// Shared response types from the API
// ---------------------------------------------------------------------------

interface ApiResourcePayload {
  resource: {
    id: string;
    name: string;
    seatCapacity: number;
    quantity: number;
    outOfServiceQty: number;
    availableQty: number;
    allocationMode: 'SHARED_SEATS' | 'WHOLE_UNIT';
    enableTimer: boolean;
    isActive: boolean;
    locationId: string | null;
    activities?: Array<{ id: string; name: string }>;
  };
  deactivated?: boolean;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface ResourceInput {
  name: string;
  seatCapacity: number;
  quantity: number;
  outOfServiceQty: number;
  allocationMode: 'SHARED_SEATS' | 'WHOLE_UNIT';
  enableTimer?: boolean;
  locationId?: string | null;
  isActive?: boolean;
  activityIds?: string[];
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Create a new resource. On success, revalidates the list and returns the new
 * resource id so the client can highlight the new row.
 */
export async function createResource(input: ResourceInput): Promise<ResourceResult> {
  try {
    await requirePermission('activity:write');
  } catch {
    return { ok: false, error: 'You do not have permission to create resources.' };
  }

  try {
    const result = await apiPost<ApiResourcePayload>('/api/resources', input);
    revalidatePath('/resources');
    return { ok: true, resourceId: result.resource.id };
  } catch (err) {
    if (isAdminApiError(err)) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Update an existing resource. `activityIds` (when provided) replaces the
 * full activity assignment set, matching the PATCH contract.
 */
export async function updateResource(
  resourceId: string,
  input: Partial<ResourceInput>,
): Promise<ResourceResult> {
  try {
    await requirePermission('activity:write');
  } catch {
    return { ok: false, error: 'You do not have permission to edit resources.' };
  }

  try {
    const result = await apiPatch<ApiResourcePayload>(`/api/resources/${resourceId}`, input);
    revalidatePath('/resources');
    return { ok: true, resourceId: result.resource.id };
  } catch (err) {
    if (isAdminApiError(err)) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Soft-delete (deactivate) a resource. The record and its activity assignments
 * are preserved; the resource is simply marked inactive.
 */
export async function deactivateResource(resourceId: string): Promise<ResourceResult> {
  try {
    await requirePermission('activity:write');
  } catch {
    return { ok: false, error: 'You do not have permission to deactivate resources.' };
  }

  try {
    await apiDelete<ApiResourcePayload>(`/api/resources/${resourceId}`);
    revalidatePath('/resources');
    return { ok: true, resourceId };
  } catch (err) {
    if (isAdminApiError(err)) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'An unexpected error occurred. Please try again.' };
  }
}

/**
 * Hard-delete a resource. Removes the row and all m2m assignment records
 * permanently. Activities themselves are untouched.
 */
export async function hardDeleteResource(resourceId: string): Promise<ResourceResult> {
  try {
    await requirePermission('activity:write');
  } catch {
    return { ok: false, error: 'You do not have permission to delete resources.' };
  }

  try {
    await apiDelete<{ deleted: boolean; id: string }>(`/api/resources/${resourceId}`, {
      hard: 'true',
    });
    revalidatePath('/resources');
    return { ok: true, resourceId };
  } catch (err) {
    if (isAdminApiError(err)) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'An unexpected error occurred. Please try again.' };
  }
}
