import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/*.db.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.nuxt/**', '**/.output/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
