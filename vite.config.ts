import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Allow overriding the backend port via env var (e.g. for E2E tests on a non-default port)
const backendPort = process.env.PORT || '3000';
const backendOrigin = `http://localhost:${backendPort}`;

export default defineConfig({
  plugins: [react()],
  base: '/ui/',
  root: './frontend',
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    // ES2022 baseline so esbuild accepts top-level await — @novnc/novnc v1.7
    // uses it in core/util/browser.js. Vite's default ('modules' = es2020 +
    // chrome87+ / firefox78+ / safari14+) errors out at prebundle time.
    // ES2022 corresponds to chrome89+ / firefox89+ / safari15+ which are all
    // 2021+ browsers — fine for DarkRide's audience.
    target: 'es2022',
    commonjsOptions: {
      // Workspace package outputs CJS; tell Rollup to transform it so named
      // exports are statically visible (e.g. pluginRegistry from /react).
      include: [/packages\/plugin-sdk\/dist\//, /node_modules/],
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './shared'),
      '@frontend': path.resolve(__dirname, './frontend'),
    },
  },
  // Pre-bundle heavy dependencies so the first dev load doesn't spend minutes
  // walking plugin frontend files for discovery. Without this, Vite's dep
  // scanner crawls every `../../../../frontend/...` relative import in plugins/,
  // which can take 4+ minutes on cold start.
  optimizeDeps: {
    // Match the build target so the dev prebundle accepts top-level await
    // (used by @novnc/novnc 1.7+). Without this, esbuild errors at startup
    // with "Top-level await is not available in the configured target
    // environment".
    esbuildOptions: { target: 'es2022' },
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-router-dom',
      'recharts',
      'react-markdown',
      'remark-gfm',
      'rehype-highlight',
      'highlight.js',
      'lucide-react',
      '@xterm/xterm',
      '@xterm/addon-fit',
      'monaco-editor',
      // Plugin transitive deps: pre-bundle CJS-only packages used by plugin
      // frontends so esbuild synthesizes named exports. Without this,
      // `await import('leaflet')` from a managed-install plugin gives a
      // namespace without `.map(...)`. Workspace plugins didn't need this
      // because Vite's scanner found the import in-tree; managed plugins
      // live outside Vite's root and aren't auto-discovered.
      'leaflet',
      // Workspace SDK ships CJS but is consumed as ESM in the browser.
      // Pre-bundling via esbuild does the interop so named imports
      // (e.g. `pluginRegistry`) work in dev. The production Rollup build
      // handles this via build.commonjsOptions.include above.
      '@darkrideapp/plugin-sdk',
      '@darkrideapp/plugin-sdk/react',
      '@darkrideapp/plugin-sdk/utils',
      // noVNC ships pure ESM with top-level await; prebundle so esbuild
      // resolves it once with the ES2022 target above instead of touching
      // it per-request.
      '@novnc/novnc',
    ],
  },
  server: {
    // Dev server is for the developer's own machine + their LAN; the
    // hostname can be anything (e.g. "code.home", a code-server proxy
    // subdomain, a tailnet host). Disable Vite's Host-header allowlist
    // so it doesn't error with "Blocked request. This host is not
    // allowed." every time the dev runs it from somewhere other than
    // localhost.
    allowedHosts: true,
    proxy: {
      '/v1': backendOrigin,
      '/data': backendOrigin,
      '/mcp': backendOrigin,
      '/oauth': backendOrigin,
      '/.well-known': backendOrigin,
      '/SKILL.md': backendOrigin,
      '/openapi.json': backendOrigin,
      '/health': backendOrigin,
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
      },
    },
  },
});
