import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'monaco-editor': path.resolve(__dirname, 'node_modules/monaco-editor/esm/vs/editor/editor.main.js'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['frontend/**/*.test.tsx', 'frontend/**/*.test.ts', 'packages/plugin-sdk/src/react/**/*.test.tsx', 'packages/plugin-sdk/src/react/**/*.test.ts'],
    setupFiles: ['./frontend/test-setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
});
