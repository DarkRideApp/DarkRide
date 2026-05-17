'use strict';

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['local'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    'local/no-direct-handle-message': 'error',
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'frontend/',
    'migrations/',
    'eslint-rules/',
  ],
  overrides: [
    {
      // Unit test files that instantiate AiAgent directly to test its internals
      // are exempt — they are testing the low-level implementation, not consuming it.
      files: ['**/*.test.ts', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js'],
      rules: {
        'local/no-direct-handle-message': 'off',
      },
    },
  ],
};
