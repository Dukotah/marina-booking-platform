/** @type {import('next').NextConfig} */
// Review/demo deployment (no live DB): the customer portal degrades gracefully to a
// "not connected" state so the UI/structure can be evaluated before infra is stood up.
const nextConfig = {
  reactStrictMode: true,
  // Optional build-output override so a second local server (e.g. a dev server
  // for design review) can run alongside a production build without the two
  // fighting over `.next`. Unset => the standard `.next`, exactly as before.
  distDir: process.env.NEXT_DIST_DIR || '.next',
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
    // Namespace the webpack runtime globals per app. Next.js forces
    // `output.library = "_N_E"` for every app, so out of the box BOTH the web
    // (:3000) and admin (:3002) dev servers emit the SAME `webpackChunk_N_E`
    // chunk-loading global and `webpackHotUpdate_N_E` HMR global. When a single
    // browser session visits both origins, one app's HMR/chunk push is handled by
    // the other app's webpack context, hard-navigating the tab across apps and
    // producing ChunkLoadError staleness. Giving each app its own globals isolates
    // the runtimes. This only changes the emitted global name, so it is safe in
    // both dev and production builds.
    config.output.chunkLoadingGlobal = 'webpackChunk_marina_web';
    config.output.hotUpdateGlobal = 'webpackHotUpdate_marina_web';
    return config;
  },
};

export default nextConfig;
