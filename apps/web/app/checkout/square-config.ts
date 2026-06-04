/**
 * Resolves the Square Web Payments SDK configuration for the checkout page.
 *
 * Square's browser SDK needs a public application id and location id. These are
 * read from environment so they stay per-deployment / per-tenant configurable
 * and are never hardcoded. When they are absent (the common case during early
 * development), the checkout renders a clearly-labelled "sandbox not configured"
 * notice instead of a live card field.
 *
 * This runs on the server (it reads non-public env on purpose) and the resolved,
 * non-secret values are passed down to the client payment component as props.
 */

export type SquareEnvironment = 'sandbox' | 'production';

export interface SquareConfig {
  /** True only when both an application id and a location id are present. */
  configured: boolean;
  /** Square application id (public, safe to send to the browser). */
  applicationId: string | null;
  /** Square location id (public, safe to send to the browser). */
  locationId: string | null;
  /** Which Square environment to load the SDK from. */
  environment: SquareEnvironment;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function getSquareConfig(): SquareConfig {
  const applicationId =
    clean(process.env.NEXT_PUBLIC_SQUARE_APPLICATION_ID) ??
    clean(process.env.SQUARE_APPLICATION_ID);
  const locationId =
    clean(process.env.NEXT_PUBLIC_SQUARE_LOCATION_ID) ??
    clean(process.env.SQUARE_LOCATION_ID);

  const rawEnv =
    clean(process.env.NEXT_PUBLIC_SQUARE_ENVIRONMENT) ??
    clean(process.env.SQUARE_ENVIRONMENT);
  const environment: SquareEnvironment =
    rawEnv === 'production' ? 'production' : 'sandbox';

  return {
    configured: Boolean(applicationId && locationId),
    applicationId,
    locationId,
    environment,
  };
}
