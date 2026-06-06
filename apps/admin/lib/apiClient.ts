import 'server-only';

/**
 * Server-to-server client for the Hono API, used by admin Server Actions /
 * Server Components for capabilities the API uniquely owns and live-tests —
 * notably the **gift-card money ledger** and **resource catalog** (D-029).
 *
 * Why call the API instead of the DB directly (the usual admin path, D-007)?
 * Those operations are the single source of truth for stored value + shared-asset
 * capacity; re-implementing them here would risk the exact ledger/capacity drift
 * the API's design prevents. So the admin reuses the proven API over HTTP, the
 * same pattern as `orders/actions.ts` → `dispatchConfirmationEmail`.
 *
 * Auth (server-to-server): we send `x-operator-id` (the API tenant middleware
 * trusts it for trusted internal calls) and, while Clerk enforcement is off
 * (dev/default, D-012), the `x-dev-staff-id` shim carrying the current staff's
 * auth_user_id so the API's `requireStaff` loads the right principal + RBAC.
 *
 * PROD FOLLOW-UP: when `REQUIRE_CLERK_AUTH=true`, the API ignores the dev shim and
 * requires a verified Clerk bearer. Forwarding the admin's Clerk session token to
 * the API is the remaining piece for enforced production (tracked in ROADMAP
 * Phase 3 / D-029). Everything is dev-gated today, so the shim path is correct now.
 */

import { getOperatorContext } from './session';

/** Resolve the API base URL (same default the web app uses). */
function apiBase(): string {
  const raw =
    process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
  return raw.replace(/\/+$/, '');
}

/** A typed API failure carrying the HTTP status + the API's structured error code. */
export class AdminApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload?: unknown;

  constructor(message: string, status: number, code?: string, payload?: unknown) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export function isAdminApiError(err: unknown): err is AdminApiError {
  return err instanceof AdminApiError;
}

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Query params appended to the path. */
  query?: Record<string, string | number | boolean | undefined>;
}

async function apiRequest<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = opts;
  const ctx = await getOperatorContext();

  let url = `${apiBase()}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    // Trusted server-to-server tenant + staff identity (see file header).
    'x-operator-id': ctx.operatorId,
    'x-dev-staff-id': ctx.auth.userId,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (process.env.INTERNAL_API_TOKEN) {
    headers.authorization = `Bearer ${process.env.INTERNAL_API_TOKEN}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
    });
  } catch (cause) {
    throw new AdminApiError(`Could not reach the API (${method} ${path}).`, 0, 'NETWORK', cause);
  }

  if (!res.ok) {
    let code: string | undefined;
    let message = `API request failed (${res.status}) for ${method} ${path}.`;
    let payload: unknown;
    try {
      payload = await res.json();
      if (payload && typeof payload === 'object') {
        const p = payload as Record<string, unknown>;
        if (typeof p.error === 'string') message = p.error;
        if (typeof p.code === 'string') code = p.code;
      }
    } catch {
      // non-JSON error body — keep the default message
    }
    throw new AdminApiError(message, res.status, code, payload);
  }

  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new AdminApiError(`Malformed API response for ${method} ${path}.`, res.status, 'BAD_JSON', cause);
  }
}

export function apiGet<T>(path: string, query?: ApiRequestOptions['query']): Promise<T> {
  return apiRequest<T>(path, { method: 'GET', query });
}
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'POST', body });
}
export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PATCH', body });
}
export function apiDelete<T>(path: string, query?: ApiRequestOptions['query']): Promise<T> {
  return apiRequest<T>(path, { method: 'DELETE', query });
}
