/** @type {import('next').NextConfig} */
// Review/demo deployment (no live DB): the customer portal degrades gracefully to a
// "not connected" state so the UI/structure can be evaluated before infra is stood up.
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@marina/types', '@marina/ui', '@marina/core'],
  // Browser-side API calls are proxied by app/api/[...path]/route.ts, NOT by a
  // rewrite. A rewrite cannot attach the `x-operator-slug` header, so every proxied
  // call reached the API with no tenant and was rejected with 400.
  webpack: (config) => {
    // Shared @marina/* packages ship TS source with NodeNext-style `.js` import
    // specifiers; let webpack resolve those to the real `.ts`/`.tsx` files.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
