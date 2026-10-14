import tseslint from 'typescript-eslint';

const networkModules = ['http', 'https', 'net', 'tls', 'dgram', 'dns', 'http2', 'undici'].flatMap((m) => [m, `node:${m}`]);

const egressRestrictions = {
  'no-restricted-imports': [
    'error',
    {
      paths: networkModules.map((name) => ({
        name,
        message: 'Network access is only allowed in src/net/egress.ts.',
      })),
    },
  ],
  'no-restricted-globals': [
    'error',
    ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
      name,
      message: 'Network access is only allowed in src/net/egress.ts.',
    })),
  ],
  'no-restricted-properties': [
    'error',
    { object: 'globalThis', property: 'fetch', message: 'Network access is only allowed in src/net/egress.ts.' },
    { object: 'window', property: 'fetch', message: 'Network access is only allowed in src/net/egress.ts.' },
    { object: 'navigator', property: 'sendBeacon', message: 'Network access is not allowed.' },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test/**', 'test/fixtures/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'webview/**/*.ts', 'webview/**/*.tsx'],
    ignores: ['src/net/**'],
    rules: egressRestrictions,
  },
  {
    files: ['test/**/*.ts', 'scripts/**', '*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
