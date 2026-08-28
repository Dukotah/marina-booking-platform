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
 *
 * Alongside it, brandStyle() emits two *derived* variables so that no caller
 * ever has to guess a legible color for an operator-chosen brand:
 *
 *   --brand-foreground  text/icons drawn ON the brand color
 *   --brand-text        the brand color used AS text on a light surface
 *
 * See the "Accessible brand foregrounds" section below for why both exist and
 * how they are computed. The rule for anyone adding brand-colored UI: never
 * hardcode `text-white` on the brand, and never paint small text in raw
 * `var(--brand-color)`. Both are contrast bugs waiting for the next operator.
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

/* -------------------------------------------------------------------------
 * Accessible brand foregrounds (WCAG 1.4.3 Contrast Minimum)
 *
 * The brand color is white-label: an operator can pick ANY hex, and several
 * plausible picks are unusable in the two places brand color normally shows up.
 * The shipped default `#0ea5e9` proves it — white text on it is 2.77:1 and the
 * color itself on white is 2.31:1, both far under the 4.5:1 floor for body
 * text. So neither foreground may be hardcoded; both are *derived* from the
 * operator's color and published as CSS variables.
 *
 * Two different problems, two different answers:
 *
 *   --brand-foreground — text drawn ON a brand-filled surface. Solved by
 *     picking the better of white / near-black. This is provably safe for every
 *     possible brand color: for any background, the better of white and black
 *     is at least 4.58:1, so a passing candidate always exists.
 *
 *   --brand-text — the brand color used AS text on a light surface. Here the
 *     hue is the point, so instead of replacing it we darken it — scaling the
 *     channels toward black keeps the hue and finds the value closest to the
 *     operator's own color that still clears 4.5:1.
 *
 * --brand-foreground is measured against the brand color itself. --brand-text
 * is measured against the DARKEST light surface the portal paints text on
 * (slate-100, #f1f5f9) rather than pure white, so one token is safe on white,
 * slate-50 and slate-100 alike and no call site has to know which panel it
 * landed in.
 * ---------------------------------------------------------------------- */

/** Body-text floor (WCAG 1.4.3 AA). Large text and UI components need only 3:1. */
const TEXT_CONTRAST = 4.5;

/**
 * The darkest neutral surface the portal puts text on (Tailwind slate-100).
 * Deriving against this rather than pure white means one token works on every
 * card, panel and page background without a per-surface variant.
 */
const DARKEST_LIGHT_SURFACE = '#f1f5f9';

type Rgb = [number, number, number];

/** Parse a #rgb / #rrggbb color into 0–255 channels, or null if unparseable. */
function parseRgb(hex: string): Rgb | null {
  const v = hex.trim().replace(/^#/, '');
  const full =
    v.length === 3 && /^[0-9a-fA-F]{3}$/.test(v)
      ? v[0] + v[0] + v[1] + v[1] + v[2] + v[2]
      : v.length === 6 && /^[0-9a-fA-F]{6}$/.test(v)
        ? v
        : null;
  if (!full) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  const channel = (c: number) =>
    Math.min(255, Math.max(0, Math.round(c)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** sRGB channel (0–255) to its linear-light value, per WCAG 2.x. */
function channelLuminance(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an RGB triple, per WCAG 2.x. */
function luminanceOf([r, g, b]: Rgb): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** Relative luminance of a #rgb / #rrggbb color, or null if unparseable. */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseRgb(hex);
  return rgb === null ? null : luminanceOf(rgb);
}

/** WCAG contrast ratio between two relative luminances (order-independent). */
export function contrastRatio(a: number, b: number): number {
  return a >= b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
}

const SURFACE_LUMINANCE = luminanceOf(parseRgb(DARKEST_LIGHT_SURFACE) as Rgb);

/**
 * Pick a label color that clears 4.5:1 on the tenant's brand color, for text
 * and icons painted on top of a brand-filled surface (buttons, badges, chips).
 *
 * Trying white, then near-black, then pure black always terminates with a
 * passing candidate — see the section comment above.
 */
export function onBrandForeground(brandColor: string): string {
  const bg = relativeLuminance(brandColor);
  if (bg === null) return '#ffffff';
  for (const candidate of ['#ffffff', '#0f172a', '#000000']) {
    const fg = relativeLuminance(candidate);
    if (fg !== null && contrastRatio(bg, fg) >= TEXT_CONTRAST) return candidate;
  }
  return '#000000';
}

/**
 * The brand color, darkened just far enough to be legible AS text on a light
 * surface — links, accents, the focus outline.
 *
 * A mid-tone brand (the default sky `#0ea5e9` is 2.31:1 on white) reads fine as
 * a button fill and fails outright as 14px text. Rather than dropping the brand
 * and printing slate, scale the channels toward black: that holds the hue, and
 * a binary search returns the *lightest* — i.e. most on-brand — variant that
 * still clears 4.5:1. Brands that already pass are returned untouched, so a
 * deep navy or forest green stays exactly as the operator chose it.
 */
export function brandTextColor(brandColor: string): string {
  const rgb = parseRgb(brandColor);
  if (rgb === null) return '#0f172a';

  // Round to whole channels BEFORE measuring. Searching on continuous channels
  // and rounding afterwards lightens the answer by up to half a step, which is
  // enough to land at 4.49:1 — a real failure produced by a "passing" search.
  const candidate = (scale: number): Rgb => [
    Math.round(rgb[0] * scale),
    Math.round(rgb[1] * scale),
    Math.round(rgb[2] * scale),
  ];
  const passes = (scale: number) =>
    contrastRatio(luminanceOf(candidate(scale)), SURFACE_LUMINANCE) >=
    TEXT_CONTRAST;

  if (passes(1)) return toHex(rgb);

  // Contrast rises monotonically as the color darkens, so bisect for the
  // largest scale that still passes. 16 steps resolves finer than one 0–255
  // step. `lo` is only ever moved to a scale that measured as passing, so the
  // returned color is verified, not inferred.
  let lo = 0; // black — always passes
  let hi = 1; // the operator's color — known to fail here
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (passes(mid)) lo = mid;
    else hi = mid;
  }
  return toHex(candidate(lo));
}

/**
 * Inline style object that publishes the tenant's brand as CSS variables.
 * Spread onto a top-level element (e.g. <body> wrapper or <header>) so
 * Tailwind's `brand` color and any `var(--brand-color)` usage reflect the
 * tenant.
 *
 * All three variables are emitted together and must stay that way: a page that
 * set `--brand-color` alone would pair a new brand with the previous brand's
 * derived foregrounds, which is exactly the contrast bug this replaces.
 */
export function brandStyle(brand: Brand = getBrand()): React.CSSProperties {
  return {
    ['--brand-color' as string]: brand.color,
    ['--brand-foreground' as string]: onBrandForeground(brand.color),
    ['--brand-text' as string]: brandTextColor(brand.color),
  };
}
