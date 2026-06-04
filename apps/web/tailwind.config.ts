import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // White-label brand color is injected per-tenant via CSS variable.
        brand: 'var(--brand-color, #0ea5e9)',
      },
    },
  },
  plugins: [],
};

export default config;
