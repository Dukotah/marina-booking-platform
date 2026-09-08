/**
 * Absolute base URL of the CUSTOMER web app (apps/web), for links the admin
 * hands to guests (e.g. the standalone waiver signer). Mirrors the API's
 * customerPortalBaseUrl resolution: CUSTOMER_PORTAL_URL wins for a real
 * deployment, NEXT_PUBLIC_WEB_BASE_URL is the existing admin-side convention
 * (see app/platform), localhost:3000 is the dev default.
 */
export function customerWebBaseUrl(): string {
  return (
    process.env.CUSTOMER_PORTAL_URL ??
    process.env.NEXT_PUBLIC_WEB_BASE_URL ??
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

/** The standalone waiver-signer URL for one order item. */
export function waiverSignLink(orderItemId: string): string {
  return `${customerWebBaseUrl()}/waiver/${encodeURIComponent(orderItemId)}`;
}
