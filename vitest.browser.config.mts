import { defineConfig } from 'vitest/config';
import base, { BROWSER_TESTS } from './vitest.config.mts';

// Not mergeConfig: it would concatenate include lists instead of replacing them.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: BROWSER_TESTS,
    exclude: [],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
