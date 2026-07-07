/** @type {import('next').NextConfig} */
// Review/demo deployment (no live DB): the customer portal degrades gracefully to a
// "not connected" state so the UI/structure can be evaluated before infra is stood up.
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@marina/types', '@marina/ui', '@marina/core'],
  // Proxy browser-side API calls through this app's own origin so they work no
  // matter how the site is reached (localhost, WSL IP, LAN). Server-side calls
  // hit the API directly via API_URL; this only covers client `fetch('/api/..')`.
  async rewrites() {
    const api = process.env.API_URL ?? 'http://localhost:3001';
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
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
