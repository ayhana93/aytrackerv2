import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Next loads `.env.local` from the app directory. This monorepo keeps one at the workspace root
 * so the API, the database commands and the web app read the same file — so the root one is
 * loaded here, without overriding anything the environment already supplies.
 *
 * Inlined rather than imported from `@aytracker/config`: this file is evaluated before the
 * workspace is transpiled, and `@aytracker/config` is a server package the web app must not
 * depend on.
 */
for (const candidate of ['.env.local', '.env']) {
  const file = path.resolve(process.cwd(), '..', '..', candidate);
  if (!existsSync(file)) continue;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@aytracker/ui',
    '@aytracker/localization',
    '@aytracker/types',
    '@aytracker/tracking',
    '@aytracker/tracking-client',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
};

export default nextConfig;
