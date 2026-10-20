import type { NextConfig } from 'next';
import { searchIndexingEnabled } from './lib/search-policy';
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  devIndicators: false,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  serverExternalPackages: ['postgres', 'pdf-parse', '@napi-rs/canvas', 'exceljs', 'mammoth'],
  // Runtime databases and local credentials must never become deployment files.
  outputFileTracingExcludes: {
    '/*': ['./.data/**/*', './.env*', './.local-admin.txt'],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      ...(!searchIndexingEnabled()
        ? [
            {
              source: '/:path*',
              headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }],
            },
          ]
        : []),
      ...['/admin/:path*', '/quotes/:path*', '/api/:path*'].map((source) => ({
        source,
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      })),
      {
        source: '/admin/site-preview',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};
export default config;
