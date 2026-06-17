import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Vitest uses esbuild (not tsc) to transform .tsx files. Without this,
    // esbuild defaults to the classic JSX transform which requires `React` in
    // scope. The automatic runtime matches tsconfig.react.json's jsx:"react-jsx".
    jsx: 'automatic',
  },
  server: {
    fs: {
      // Allow discover.ts to dynamically import() plugin entry files from outside the
      // project root (e.g. temp dirs in DARKRIDE_PLUGIN_DIRS or managed install prefix).
      allow: ['/'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: [
      // `node_modules` (literal) only matches the top-level dir. Use the
      // **/node_modules/** glob to also skip nested copies under
      // packages/*/node_modules and managed plugin installs.
      '**/node_modules/**',
      '**/dist/**',
      'frontend/**',
      'packages/plugin-sdk/src/react/**',
      // Worktrees re-mount the entire repo at a nested path. Without
      // excluding them, every test file in main also runs from the worktree
      // copy, causing duplicate-execution failures (file conflicts, races,
      // shared CWD-relative state). Cover both Superpowers `.worktrees/`
      // and Claude Code `.claude/worktrees/` conventions.
      '**/.worktrees/**',
      '**/.claude/worktrees/**',
      // Plugin install root contains tarball-bundled test files from
      // third-party deps that should never run as part of our suite.
      '**/data/installed-plugins/**',
      // E2E tests require a live server + Docker and run via their own
      // config (tests/e2e/vitest.config.ts). They must not run in the
      // default gate suite, where they fail fast with no server.
      'tests/e2e/**',
    ],
    // Use process forks (not threads) — each fork is an isolated process whose
    // memory is fully reclaimed on exit. With 24 CPU cores and 130+ test files
    // that each create in-memory SQLite DBs + argon2 (19MB per hash), the default
    // thread pool was hitting 85GB+ RAM. Forks with a cap of 4 keeps it under 2GB.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.test.ts'],
    },
  },
});
