const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: path.join('tmp', 'ps-next-build-' + (process.env.USER || 'dev')),
  experimental: {
    serverComponentsExternalPackages: ['pino', 'pino-pretty', '@prisma/client', '.prisma/client'],
    instrumentationHook: true,
  },
};

module.exports = nextConfig;
