/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@marina/types', '@marina/ui', '@marina/core'],
};

export default nextConfig;
