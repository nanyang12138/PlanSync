const path = require('path');

/**
 * F1 / closes the dev.sh ↔ next.config.js USER-fallback consistency
 * cluster (#287 / #289 / #366 / #540 / #567 + 4 sibling findings).
 *
 * Background. `distDir` namespaces the Next.js build output so multiple
 * users on a shared host don't clobber each other. The previous
 * implementation used `process.env.USER || 'dev'`; dev.sh used
 * `${USER:-$(whoami)}`. When `USER` was unset (e.g. a `cron` shell, a
 * minimal CI runner, certain Docker bases) the two values disagreed —
 * dev.sh's cache-clear logic operated on `tmp/ps-next-build-<whoami>`
 * but next.config.js wrote build output to `tmp/ps-next-build-dev`,
 * leaving stale caches around forever.
 *
 * The fix is a single canonical env var, `PLANSYNC_BUILD_USER`, that
 * EVERY caller (dev.sh, build.sh, ad-hoc `npm run build`, cron) sets
 * deterministically. We still honour `USER` for back-compat as a
 * second-priority fallback, so an existing manual workflow that
 * exported `USER` keeps working unchanged. The final fallback is
 * `'shared'` (was `'dev'`); rename calls out that the directory is
 * intentionally shared by anyone who didn't pick a user identity.
 */
function resolveBuildUser() {
  const explicit = (process.env.PLANSYNC_BUILD_USER || '').trim();
  if (explicit) return explicit;
  const fromUser = (process.env.USER || '').trim();
  if (fromUser) return fromUser;
  return 'shared';
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: path.join('tmp', 'ps-next-build-' + resolveBuildUser()),
  // R-131 / G3 (Next.js 15 migration):
  //   - `experimental.serverComponentsExternalPackages` was promoted to
  //     the top-level `serverExternalPackages` in Next 15.
  //   - `experimental.instrumentationHook` is removed because
  //     `instrumentation.js` is enabled by default in Next 15+.
  // #143 (preserved from master): `pg` + `pg-native` must also be marked
  // external for route-handler Node runtime so webpack's production
  // minifier doesn't mangle `Client` -> `e` and break EventBusPG.
  serverExternalPackages: [
    'pino',
    'pino-pretty',
    '@prisma/client',
    '.prisma/client',
    'pg',
    'pg-native',
  ],
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
