const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: path.join('tmp', 'ps-next-build-' + (process.env.USER || 'dev')),
  experimental: {
    serverComponentsExternalPackages: [
      'pino',
      'pino-pretty',
      '@prisma/client',
      '.prisma/client',
      'pg',
      'pg-native',
    ],
    instrumentationHook: true,
  },
  // `pg`'s `Client` class is loaded through route handlers (event bus, prisma,
  // health) — NOT through React Server Components. In Next.js 14
  // `experimental.serverComponentsExternalPackages` only covers RSCs, so for
  // route-handler Node runtime we additionally tell webpack to keep `pg`
  // (and its optional native peer `pg-native`) as runtime require()s.
  // Without this, webpack's production minifier mangles the `Client` export
  // into `e`, causing `new pg.Client()` inside `EventBusPG` to throw
  // `TypeError: e is not a constructor` (root cause of nightly e2e
  // failure #143 — `EventBusPG failed to initialise and fallback is forbidden
  // in this configuration`).
  webpack: (config, { isServer }) => {
    if (isServer) {
      const existing = Array.isArray(config.externals)
        ? config.externals
        : config.externals
        ? [config.externals]
        : [];
      config.externals = [...existing, 'pg', 'pg-native'];
    }
    return config;
  },
};

module.exports = nextConfig;
