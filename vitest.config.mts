import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    alias: {
      vscode: fileURLToPath(new URL('./test/unit/vscode-stub.ts', import.meta.url)),
    },
  },
});
