/**
 * White-label brand resolution for the customer portal.
 *
 * The portal must render as the OPERATOR's brand, never the platform's. Brand
 * data ultimately comes from the resolved tenant (Operator: name_external,
 * brand_color, logos). Until a public operator endpoint is wired, this reads
 * from environment so the value is still tenant-configurable per deployment and
 * never hardcodes a specific marina's branding.
 *
 * The resolved brand color is applied to the `--brand-color` CSS variable (see
 * globals.css and tailwind.config.ts `brand`), so all brand-colored UI follows
 * the tenant automatically.
 */

import { DEMO_MODE } from './demo/config';

export interface Brand {
  /** Customer-facing operator name (Operator.name_external). */
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

/**
 * In DEMO_MODE, the portal ships as a concrete tenant (Lake Sonoma Marina) so the
 * link reads as a real product rather than a blank white-label shell. Any explicit
 * BRAND_* env still wins over this.
 */
const DEMO_BRAND: Brand = {
  name: 'Lake Sonoma Marina',
  color: '#0369a1',
  logoLightUrl: null,
  logoDarkUrl: null,
  tagline: 'Boat rentals, kayaks & lakeside adventures on Lake Sonoma',
};

const BASE_BRAND: Brand = DEMO_MODE ? DEMO_BRAND : DEFAULT_BRAND;

function clean(value: string | undefined | null): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Validate a CSS hex color; fall back to the base brand color when malformed. */
function safeColor(value: string | undefined | null): string {
  const v = clean(value);
  if (v && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return v;
  return BASE_BRAND.color;
}

/**
 * Resolve the active tenant's brand. Currently env-backed (stubbed) but shaped
 * so it can be swapped for a fetched operator endpoint without touching callers.
 */
export function getBrand(): Brand {
  return {
    name: clean(process.env.BRAND_NAME) ?? BASE_BRAND.name,
    color: safeColor(process.env.BRAND_COLOR),
    logoLightUrl: clean(process.env.BRAND_LOGO_LIGHT_URL) ?? BASE_BRAND.logoLightUrl,
    logoDarkUrl: clean(process.env.BRAND_LOGO_DARK_URL) ?? BASE_BRAND.logoDarkUrl,
    tagline: clean(process.env.BRAND_TAGLINE) ?? BASE_BRAND.tagline,
  };
}

/**
 * Inline style object that sets the `--brand-color` CSS variable. Spread onto a
 * top-level element (e.g. <body> wrapper or <header>) so Tailwind's `brand`
 * color and any `var(--brand-color)` usage reflect the tenant.
 */
export function brandStyle(brand: Brand = getBrand()): React.CSSProperties {
  return { ['--brand-color' as string]: brand.color };
}
