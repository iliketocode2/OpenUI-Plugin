import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/** Tests that start a real headless Chrome or Edge. They run separately (npm run test:browser) because they are slow and
 * time out when the CPU is busy, which on a machine running a local model is most of the time. */
export const BROWSER_TESTS = ['test/unit/browserTool.test.ts', 'test/egress/browser-egress.test.ts'];

export default defineConfig({
  plugins: [
    {
      name: 'markdown-as-text',
      transform(code, id) {
        return id.endsWith('.md') ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined;
      },
    },
  ],
  test: {
    include: ['test/unit/**/*.test.ts', 'test/egress/**/*.test.ts'],
    exclude: BROWSER_TESTS,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    alias: {
      vscode: fileURLToPath(new URL('./test/unit/vscode-stub.ts', import.meta.url)),
    },
  },
});
