/**
 * Color utilities for catalog cards.
 *
 * Activity cards use the activity's own `color` (a tenant-configured hex) as the
 * header background. To keep the overlaid name/icon legible across light and
 * dark colors, we compute a readable foreground (black vs white) from the
 * background's perceived luminance. Pure presentation — no branding decisions.
 */

/** Parse a #rgb or #rrggbb hex string into [r, g, b] 0–255, or null if invalid. */
function parseHex(hex: string): [number, number, number] | null {
  const v = hex.trim().replace(/^#/, '');
  if (v.length === 3 && /^[0-9a-fA-F]{3}$/.test(v)) {
    const r = parseInt(v[0] + v[0], 16);
    const g = parseInt(v[1] + v[1], 16);
    const b = parseInt(v[2] + v[2], 16);
    return [r, g, b];
  }
  if (v.length === 6 && /^[0-9a-fA-F]{6}$/.test(v)) {
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return [r, g, b];
  }
  return null;
}

/**
 * Return a readable text color ('#ffffff' or '#0f172a') for content placed on
 * the given background hex. Uses the WCAG relative-luminance approximation; a
 * mid threshold keeps both light and dark backgrounds legible. Falls back to
 * white when the input is not a usable hex.
 */
export function readableTextOn(backgroundHex: string): string {
  const rgb = parseHex(backgroundHex);
  if (!rgb) return '#ffffff';
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? '#0f172a' : '#ffffff';
}
