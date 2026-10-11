import type { Config } from 'tailwindcss';

/**
 * Admin "Clean SaaS" theme. Semantic colors read from the CSS variables defined
 * in app/globals.css so the whole app has ONE source of truth. Use these
 * utilities in shared chrome and new pages:
 *
 *   bg-canvas            app background (very light cool gray)
 *   bg-surface           white card / panel
 *   bg-surface-muted     subtle inset (table head, wells)
 *   border-line          hairline border (neutral-200)
 *   border-line-strong   stronger divider (neutral-300)
 *   text-ink             headings (neutral-900)
 *   text-ink-body        body (neutral-600)
 *   text-ink-muted       muted / placeholder (slate-400)
 *   bg-accent / text-accent / border-accent        teal-600 (the ONE accent)
 *   bg-accent-hover      teal-500
 *   bg-accent-tint / text-accent-ink               teal-50 / teal-700 (nav-selected)
 *   ring-focus           focus ring (teal-300)
 *
 * Semantic tones keep their standard Tailwind palettes (used as tinted chips
 * bg-*-50 text-*-700): rose = money owed, amber = waiver/waitlist/waiting,
 * emerald = checked-in/success, slate = cancelled/neutral. Do NOT add blue/indigo.
 */
const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: rgb('--canvas'),
        surface: {
          DEFAULT: rgb('--surface'),
          muted: rgb('--surface-muted'),
        },
        line: {
          DEFAULT: rgb('--line'),
          strong: rgb('--line-strong'),
        },
        ink: {
          DEFAULT: rgb('--ink'),
          body: rgb('--ink-body'),
          muted: rgb('--ink-muted'),
        },
        accent: {
          DEFAULT: rgb('--accent'),
          hover: rgb('--accent-hover'),
          tint: rgb('--accent-tint'),
          ink: rgb('--accent-ink'),
        },
        focus: rgb('--ring'),
      },
      borderRadius: {
        lg: '0.5rem',
      },
      boxShadow: {
        sm: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
