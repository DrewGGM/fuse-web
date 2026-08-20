// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**', '.wrangler/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      complexity: ['warn', 12],
      'max-depth': ['warn', 3],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'smart'],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The service worker runs in a worker global, not the browser one.
    files: ['public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    // Tooling straddles Node and browser contexts inside page.evaluate().
    files: ['scripts/**', 'e2e/**', 'test/**'],
    rules: { 'no-undef': 'off', 'no-console': 'off' },
  }
);
