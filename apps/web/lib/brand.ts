/**
 * White-label brand resolution for the customer portal.
 *
 * The portal must render as the OPERATOR's brand, never the platform's. Brand
 * data comes from the resolved tenant via GET /api/operator/public (operator:
 * name, brand_color, logos). Environment variables + neutral defaults serve as
 * a graceful fallback when the API is unreachable so the storefront always
 * renders — never 500s on a brand-fetch failure.
 *
 * The resolved brand color is applied to the `--brand-color` CSS variable (see
 * globals.css and tailwind.config.ts `brand`), so all brand-colored UI follows
 * the tenant automatically.
 */

import { cache } from 'react';
import { getOperatorPublic } from './api';

export interface Brand {
  /** Customer-facing operator name (Operator.name). */
  name: string;
  /** Hex brand color, e.g. "#0ea5e9" (Operator.brand_color). */
  color: string;
  /** Logo for light backgrounds, if configured. */
  logoLightUrl: string | null;
  /** Logo for dark backgrounds, if configured. */
  logoDarkUrl: string | null;
  /** Optional tagline shown under the name. */
  tagline: string | null;
}

/** Sensible neutral defaults — no platform or marina-specific branding. */
const DEFAULT_BRAND: Brand = {
  name: 'Book Your Adventure',
  color: '#0ea5e9',
  logoLightUrl: null,
  logoDarkUrl: null,
  tagline: null,
};

function clean(value: string | undefined | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Validate a CSS hex color; fall back to the default when malformed. */
function safeColor(value: string | undefined | null): string {
  const v = clean(value);
  if (v && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return v;
  return DEFAULT_BRAND.color;
}

/** Env-backed fallback brand — used when the API is unreachable or returns nothing. */
function envBrand(): Brand {
  return {
    name: clean(process.env.BRAND_NAME) ?? DEFAULT_BRAND.name,
    color: safeColor(process.env.BRAND_COLOR),
    logoLightUrl: clean(process.env.BRAND_LOGO_LIGHT_URL),
    logoDarkUrl: clean(process.env.BRAND_LOGO_DARK_URL),
    tagline: clean(process.env.BRAND_TAGLINE),
  };
}

/**
 * Resolve the active tenant's brand from the operator public API.
 *
 * Wrapped with React `cache()` so multiple server components awaiting this
 * within the same render tree share a single fetch (deduplicated per request).
 *
 * Graceful degradation: if the API is unreachable or returns nothing, the
 * function returns the env-backed / neutral default brand — it never throws,
 * so a brand-fetch failure cannot cause a 500.
 */
export const getBrand: () => Promise<Brand> = cache(async (): Promise<Brand> => {
  const fallback = envBrand();
  try {
    const op = await getOperatorPublic();
    if (!op) return fallback;
    return {
      name: clean(op.name) ?? fallback.name,
      color: safeColor(op.brand_color) ?? fallback.color,
      logoLightUrl: clean(op.logo_light_url),
      logoDarkUrl: clean(op.logo_dark_url),
      // Tagline is not part of the public operator contract; keep env value.
      tagline: fallback.tagline,
    };
  } catch {
    // Defensive catch — getOperatorPublic itself never throws, but guard anyway.
    return fallback;
  }
});

/**
 * Inline style object that sets the `--brand-color` CSS variable. Spread onto a
 * top-level element (e.g. <body> wrapper or <header>) so Tailwind's `brand`
 * color and any `var(--brand-color)` usage reflect the tenant.
 *
 * Takes an already-resolved Brand so it stays synchronous at the render site.
 */
export function brandStyle(brand: Brand): React.CSSProperties {
  return { ['--brand-color' as string]: brand.color };
}
