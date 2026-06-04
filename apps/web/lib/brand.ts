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

/**
 * Resolve the active tenant's brand. Currently env-backed (stubbed) but shaped
 * so it can be swapped for a fetched operator endpoint without touching callers.
 */
export function getBrand(): Brand {
  return {
    name: clean(process.env.BRAND_NAME) ?? DEFAULT_BRAND.name,
    color: safeColor(process.env.BRAND_COLOR),
    logoLightUrl: clean(process.env.BRAND_LOGO_LIGHT_URL),
    logoDarkUrl: clean(process.env.BRAND_LOGO_DARK_URL),
    tagline: clean(process.env.BRAND_TAGLINE),
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
