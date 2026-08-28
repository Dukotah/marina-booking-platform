import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    /*
     * Shared design-system components render into THIS app, so their classes
     * have to be scanned here or Tailwind never emits the rules.
     *
     * Leaving them out was not cosmetic: `Button variant="brand"` is
     * `bg-[var(--brand-color,#0f766e)] text-white`, an arbitrary-value class
     * used nowhere else, so it was never generated and the checkout's
     * "Complete booking" button rendered white label text on the bare page
     * background — 1.04:1, the worst contrast failure in the audit and an
     * effectively invisible primary CTA. (WCAG 1.4.3.)
     */
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // White-label brand color is injected per-tenant via CSS variable.
        // Safe as a fill (bg-/border-/ring-); for brand-colored TEXT use the
        // `.text-brand` override in globals.css, which resolves to the
        // contrast-corrected `--brand-text`. See lib/brand.ts.
        brand: 'var(--brand-color, #0ea5e9)',

        /*
         * Contrast-corrected palette tokens (WCAG 1.4.3, 4.5:1 for body text).
         *
         * These are text colors used across ~40 components, so they are fixed
         * once here rather than edited call site by call site — the previous
         * pass tried the latter and the audit found two dozen survivors.
         * `extend` deep-merges, so every other shade of each ramp is untouched.
         *
         * Ratios below are measured against the three surfaces this portal
         * actually paints text on: white, slate-50 (#f8fafc, the page
         * background) and slate-100 (#f1f5f9, inset panels).
         */
        slate: {
          /*
           * 400 was #94a3b8 — 2.56:1 on white, 2.34:1 on slate-100. It is used
           * for text only (34 sites, no bg-/border-/ring- usage), so retinting
           * it changes nothing but legibility.
           *
           * 500 was #64748b: it passes on white (4.76:1) but lands at 4.34:1 on
           * slate-100, so it carried a latent failure of its own. Both now
           * resolve to the same value, which is not a shortcut — AA simply
           * leaves no room for two distinct muted greys above slate-600. The
           * value is slate-500 mixed 20% toward slate-600, i.e. the lightest
           * point on the existing ramp that clears 4.5:1 on every surface
           * above, so "muted" still reads as muted next to slate-700/900.
           *
           * 5.20:1 on white · 4.97:1 on slate-50 · 4.75:1 on slate-100.
           */
          400: '#5e6e84',
          500: '#5e6e84',
        },
        emerald: {
          /*
           * 600 was #059669 — 3.77:1 on white, which fails both as the
           * confirmation page's "Paid in full" text and as the fill behind the
           * white label on the guest-prefill button. Retinted to emerald-700's
           * value: still unmistakably the "paid / good" green, now 5.48:1 on
           * white and 5.01:1 on slate-100.
           */
          600: '#047857',
        },
      },
    },
  },
  plugins: [],
};

export default config;
