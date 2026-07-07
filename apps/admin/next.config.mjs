/** @type {import('next').NextConfig} */
// Review/demo deployment (no live DB): the admin app degrades to an empty dashboard
// with a "Live data unavailable" notice so the UI/structure can be evaluated first.
const nextConfig = {
  reactStrictMode: true,
  // All @marina/* workspace packages ship TypeScript source — webpack must
  // transpile them. This includes @marina/database; listing it in
  // serverComponentsExternalPackages would make Next.js try to require() the
  // raw .ts entry point via Node, which fails on Vercel's Node 18/20 runtime.
  transpilePackages: [
    '@marina/types',
    '@marina/ui',
    '@marina/core',
    '@marina/auth',
    '@marina/database',
  ],
  experimental: {
    // @prisma/client ships pre-compiled JS + native binaries — it must stay
    // external so webpack does not try to bundle the native .node files.
    // @marina/database is intentionally NOT listed here (see transpilePackages).
    serverComponentsExternalPackages: ['@prisma/client'],
  },
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
