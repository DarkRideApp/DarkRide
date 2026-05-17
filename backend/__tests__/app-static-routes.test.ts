import { describe, it, expect } from 'vitest';
import { app } from '../app';

/**
 * The Express app must NOT carry unauthenticated handlers for /data/screenshots
 * or /data/apks. Both used to be public `express.static` mounts in app.ts —
 * before initAuth() ran, so anyone who could reach the host could fetch
 * screenshots or APKs by guessing the filename.
 *
 * The supported auth-gated routes for the same content are:
 *   - GET /v1/screenshots/:filename       (core.automations:edit scope)
 *   - GET /v1/apps/download/:versionId    (registered under API router, after auth)
 *
 * If a future change adds `app.use('/data/...', express.static(...))` back
 * into app.ts (or anywhere else that runs before initAuth), this test fails
 * loudly. See SECURITY.md "Known gaps" history.
 */
describe('app.ts — unauthenticated static-route bypass', () => {
  function appLayers(): Array<{ regexp: any; name?: string; path?: string }> {
    // Express's internal layer list. Each entry has a `regexp` (route matcher)
    // and a `name` (middleware function name).
    return (app as any)._router?.stack ?? [];
  }

  function hasMountFor(pathPrefix: string): boolean {
    // Global middlewares (json parser, etc.) compile to a regex that matches
    // every path — `/^\/?(?=\/|$)/i`. A path-prefix mount like
    // app.use('/data/apks', …) compiles to a regex whose source contains the
    // escaped prefix. We look for the literal prefix in the regex source so
    // global middlewares don't trigger a false positive.
    const needle = pathPrefix.replace(/\//g, '\\/');
    return appLayers().some(layer => {
      const source = layer.regexp?.source ?? '';
      return source.includes(needle);
    });
  }

  it('does not mount /data/screenshots as a static handler', () => {
    expect(hasMountFor('/data/screenshots')).toBe(false);
  });

  it('does not mount /data/apks as a static handler', () => {
    expect(hasMountFor('/data/apks')).toBe(false);
  });
});
