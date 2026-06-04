/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@marina/types', '@marina/ui', '@marina/core', '@marina/auth'],
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', '@marina/database'],
  },
};

export default nextConfig;
