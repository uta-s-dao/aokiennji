import type { NextConfig } from 'next';
const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  devIndicators: false,
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  serverExternalPackages: ['better-sqlite3', 'pdf-parse', 'exceljs', 'mammoth'],
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
    ];
  },
};
export default config;
