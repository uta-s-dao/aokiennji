import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import vinext from 'vinext';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(?:@\/lib\/server\/|.*\/lib\/server\/)source-verification(?:\.ts)?$/,
        replacement: fileURLToPath(
          new URL('./lib/server/source-verification-production.ts', import.meta.url),
        ),
      },
      { find: /^@cf-wasm\/photon$/, replacement: '@cf-wasm/photon/workerd' },
    ],
  },
  plugins: [
    vinext(),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
});
