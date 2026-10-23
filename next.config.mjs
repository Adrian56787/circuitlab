/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath: '/circuitlab',
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
