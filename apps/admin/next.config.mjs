/** @type {import('next').NextConfig} */
// Review/demo deployment (no live DB): the admin app degrades to an empty dashboard
// with a "Live data unavailable" notice so the UI/structure can be evaluated first.
const nextConfig = {
  reactStrictMode: true,
  // CI/verification builds can run WHILE `next dev` is serving the operator by
  // pointing at a separate dist dir (NEXT_DIST_DIR=.next-build) — a plain
  // `next build` would clobber the dev server's .next cache mid-session.
  distDir: process.env.NEXT_DIST_DIR || '.next',
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
    // Namespace the webpack runtime globals per app. Next.js forces
    // `output.library = "_N_E"` for every app, so out of the box BOTH the admin
    // (:3002) and web (:3000) dev servers emit the SAME `webpackChunk_N_E`
    // chunk-loading global and `webpackHotUpdate_N_E` HMR global. When a single
    // browser session visits both origins, one app's HMR/chunk push is handled by
    // the other app's webpack context, hard-navigating the tab across apps and
    // producing ChunkLoadError staleness. Giving each app its own globals isolates
    // the runtimes. This only changes the emitted global name, so it is safe in
    // both dev and production builds.
    config.output.chunkLoadingGlobal = 'webpackChunk_marina_admin';
    config.output.hotUpdateGlobal = 'webpackHotUpdate_marina_admin';
    return config;
  },
};

export default nextConfig;

// Touched 2026-09-08: Prisma client regenerated (OrderMerchandiseLine) — this
// comment change makes `next dev` restart itself so the fresh client loads.
