import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/system/**/*.system.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
