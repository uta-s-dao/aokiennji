import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', setupFiles: ['tests/database-setup.ts'], hookTimeout: 30000, fileParallelism: false },
});
