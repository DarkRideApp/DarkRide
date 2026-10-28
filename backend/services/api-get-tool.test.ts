import { describe, it, expect, beforeEach, vi } from 'vitest';
import { clearEndpoints, registerEndpoint } from '../api/api-service';
import { AiToolRegistry, type ToolCaller } from './ai-tools';
import {
  API_GET_MAX_CHARS,
  API_GET_TIMEOUT_MS,
  isApiGetAllowed,
  registerApiGetTool,
  runApiGet,
  validateApiGetPath,
} from './api-get-tool';

function caller(scopes: string[] = []): ToolCaller {
  return { userId: 7, username: 'cube', via: 'oauth', effectiveScopes: new Set(scopes) };
}

describe('validateApiGetPath', () => {
  it.each(['/disney-menus/targets', '/v1/system/status', '/disney-menus/targets/12'])(
    'accepts %s',
    (p) => {
      expect(validateApiGetPath(p)).toEqual({ ok: true, path: p });
    },
  );

  it.each([
    ['empty', ''],
    ['no leading slash', 'v1/system/status'],
    ['scheme and host', 'http://evil.example/v1/x'],
    ['protocol-relative host', '//evil.example/v1/x'],
    ['dot-dot segment', '/v1/../settings/list'],
    ['encoded dot-dot', '/v1/%2e%2e/settings/list'],
    ['encoded dot-dot upper case', '/v1/%2E%2E/settings/list'],
    ['single dot segment', '/v1/./system/status'],
    ['encoded slash', '/v1/system%2fstatus'],
    ['encoded backslash', '/v1/system%5cstatus'],
    ['backslash', '/v1/system\\status'],
    ['empty segment', '/v1//system/status'],
    ['query in path', '/v1/system/status?x=1'],
    ['fragment in path', '/v1/system/status#x'],
    ['encoded NUL', '/v1/system%00'],
    ['malformed escape', '/v1/system/%zz'],
    ['control character', '/v1/system/\u0007'],
    ['double-encoded dot-dot', '/v1/%252e%252e/settings'],
  ])('rejects %s', (_label, p) => {
    expect(validateApiGetPath(p).ok).toBe(false);
  });

  it('rejects non-strings and over-long paths', () => {
    expect(validateApiGetPath(undefined).ok).toBe(false);
    expect(validateApiGetPath(42).ok).toBe(false);
    expect(validateApiGetPath('/' + 'a'.repeat(600)).ok).toBe(false);
  });
});

describe('isApiGetAllowed', () => {
  it.each([
    '/disney-menus/status',
    '/disney-menus/targets/12',
    '/v1/system/status',
    '/v1/plugins/list',
    '/v1/plugins/registry',
  ])('allows %s', (p) => {
    expect(isApiGetAllowed(p)).toBe(true);
  });

  it.each([
    // Sensitive routes: refused because they are not on the allow-list.
    '/v1/credentials/list',
    '/v1/proxy/list',
    '/v1/proxy/view/3',
    '/v1/certs',
    '/v1/settings/list',
    '/v1/profile/api-keys',
    '/v1/auth/me',
    // Not on the allow-list.
    '/v1/traffic/list',
    '/v1/plugins/installed',
    // Prefix must end on a segment boundary.
    '/disney-menus-evil/status',
    '/v1/system/status-extra',
  ])('denies %s', (p) => {
    expect(isApiGetAllowed(p)).toBe(false);
  });

  it('denies secret-looking segments even under an allowed prefix', () => {
    expect(isApiGetAllowed('/disney-menus/token')).toBe(false);
    expect(isApiGetAllowed('/disney-menus/targets/12/secrets')).toBe(false);
    expect(isApiGetAllowed('/disney-menus/api-keys')).toBe(false);
    expect(isApiGetAllowed('/disney-menus/password')).toBe(false);
  });

  it('is case-insensitive and decodes before matching', () => {
    expect(isApiGetAllowed('/V1/Credentials/list')).toBe(false);
    expect(isApiGetAllowed('/disney-menus/%74oken')).toBe(false);
    expect(isApiGetAllowed('/DISNEY-MENUS/status')).toBe(true);
  });
});

describe('runApiGet', () => {
  beforeEach(() => {
    clearEndpoints();
  });

  it('refuses to run without an authenticated caller', async () => {
    await expect(runApiGet({ path: '/disney-menus/status' }, undefined)).rejects.toThrow(
      /authenticated caller/i,
    );
  });

  it('rejects an invalid path before dispatching anything', async () => {
    const handler = vi.fn();
    registerEndpoint('GET', '/v1/system/status', handler);
    await expect(runApiGet({ path: '/v1/../system/status' }, caller())).rejects.toThrow(/path/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches to a registered GET handler with params, query and identity', async () => {
    const seen: any = {};
    registerEndpoint('GET', '/disney-menus/targets/:id', (req, res) => {
      seen.params = req.params;
      seen.query = req.query;
      seen.method = req.method;
      seen.body = req.body;
      seen.user = req.authUser?.username;
      res.json({ id: req.params.id, ok: true });
    });

    const result = await runApiGet(
      { path: '/disney-menus/targets/12', query: { limit: 5, flag: true, q: 'abc' } },
      caller(),
    );

    expect(result).toEqual({ status: 200, body: { id: '12', ok: true } });
    expect(seen.params).toEqual({ id: '12' });
    expect(seen.query).toEqual({ limit: '5', flag: 'true', q: 'abc' });
    expect(seen.method).toBe('GET');
    expect(seen.body).toEqual({});
    expect(seen.user).toBe('cube');
  });

  it('decodes path parameters', async () => {
    let id: string | undefined;
    registerEndpoint('GET', '/disney-menus/targets/:id', (req, res) => {
      id = req.params.id;
      res.json({});
    });
    await runApiGet({ path: '/disney-menus/targets/a%20b' }, caller());
    expect(id).toBe('a b');
  });

  it('never reaches a handler registered under another method', async () => {
    const handler = vi.fn((_req, res) => res.json({}));
    registerEndpoint('POST', '/disney-menus/status', handler);
    registerEndpoint('DELETE', '/disney-menus/status', handler);
    const result = await runApiGet({ path: '/disney-menus/status' }, caller());
    expect(result.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 404 for an unregistered path', async () => {
    const result = await runApiGet({ path: '/disney-menus/nope' }, caller());
    expect(result.status).toBe(404);
  });

  it('does not invoke the handler for a path off the allow-list', async () => {
    const handler = vi.fn((_req, res) => res.json({ data: [{ password: 'hunter2' }] }));
    registerEndpoint('GET', '/v1/credentials/list', handler, { requires: ['core.credentials:read'] });
    const result = await runApiGet({ path: '/v1/credentials/list' }, caller(['core.admin:*']));
    expect(result.status).toBe(403);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(handler).not.toHaveBeenCalled();
  });

  describe('scopes', () => {
    beforeEach(() => {
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.json({ ok: true }), {
        requires: ['plugin.disney-menus:read'],
      });
    });

    it('returns 403 and skips the handler when the caller lacks the endpoint scope', async () => {
      const handler = vi.fn((_req, res) => res.json({}));
      clearEndpoints();
      registerEndpoint('GET', '/disney-menus/status', handler, { requires: ['plugin.disney-menus:read'] });
      const result = await runApiGet({ path: '/disney-menus/status' }, caller(['core.traffic:read']));
      expect(result.status).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it('runs the handler when the caller holds the scope', async () => {
      const result = await runApiGet(
        { path: '/disney-menus/status' },
        caller(['plugin.disney-menus:read']),
      );
      expect(result).toEqual({ status: 200, body: { ok: true } });
    });

    it('honours wildcard grants', async () => {
      const result = await runApiGet({ path: '/disney-menus/status' }, caller(['core.admin:*']));
      expect(result.status).toBe(200);
    });
  });

  describe('response shaping', () => {
    it('returns plain text bodies as text', async () => {
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => {
        res.status(202).send('hello');
      });
      expect(await runApiGet({ path: '/disney-menus/status' }, caller())).toEqual({
        status: 202,
        body: 'hello',
      });
    });

    it('omits binary bodies', async () => {
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => {
        res.send(Buffer.alloc(2048));
      });
      const result = await runApiGet({ path: '/disney-menus/status' }, caller());
      expect(result.status).toBe(200);
      expect(result.body).toBe('[binary body omitted: 2048 bytes]');
    });

    it('treats an empty end() as a null body', async () => {
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => {
        res.status(204).end();
      });
      expect(await runApiGet({ path: '/disney-menus/status' }, caller())).toEqual({
        status: 204,
        body: null,
      });
    });

    it('truncates an oversize body with a marker and reports the full size', async () => {
      const big = { rows: Array.from({ length: 20_000 }, (_, i) => ({ i, pad: 'x'.repeat(20) })) };
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.json(big));
      const result = await runApiGet({ path: '/disney-menus/status' }, caller());
      expect(result.truncated).toBe(true);
      expect(result.totalChars).toBe(JSON.stringify(big).length);
      expect(typeof result.body).toBe('string');
      expect((result.body as string).length).toBeLessThan(API_GET_MAX_CHARS + 200);
      expect(result.body as string).toContain('[truncated');
    });

    it('leaves a body at the cap untouched', async () => {
      const body = 'y'.repeat(API_GET_MAX_CHARS);
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.send(body));
      const result = await runApiGet({ path: '/disney-menus/status' }, caller());
      expect(result.truncated).toBeUndefined();
      expect(result.body).toBe(body);
    });
  });

  describe('failure handling', () => {
    it('turns a throwing handler into a 500', async () => {
      registerEndpoint('GET', '/disney-menus/status', () => {
        throw new Error('db is on fire');
      });
      const result = await runApiGet({ path: '/disney-menus/status' }, caller());
      expect(result.status).toBe(500);
      expect(JSON.stringify(result.body)).toContain('db is on fire');
    });

    it('turns an unsupported response method into a 500 naming the method', async () => {
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => {
        (res as any).sendFile('/etc/passwd');
      });
      const result = await runApiGet({ path: '/disney-menus/status' }, caller());
      expect(result.status).toBe(500);
      expect(JSON.stringify(result.body)).toContain('sendFile');
    });

    it('times out a handler that never answers', async () => {
      registerEndpoint('GET', '/disney-menus/status', () => {
        /* never responds */
      });
      const result = await runApiGet({ path: '/disney-menus/status' }, caller(), { timeoutMs: 20 });
      expect(result.status).toBe(504);
    });

    it('rejects non-primitive query values', async () => {
      registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.json({}));
      await expect(
        runApiGet({ path: '/disney-menus/status', query: { a: { b: 1 } as any } }, caller()),
      ).rejects.toThrow(/query/i);
    });
  });
});

describe('registerApiGetTool', () => {
  beforeEach(() => {
    clearEndpoints();
  });

  function setup() {
    const registry = new AiToolRegistry();
    registerApiGetTool(registry);
    return registry;
  }

  it('registers a tool whose schema offers a path and a query and nothing else', () => {
    const tool = setup().getToolsForContext('api').find((t) => t.name === 'darkride_api_get');
    expect(tool).toBeDefined();
    const props = Object.keys((tool!.inputSchema as any).properties).sort();
    expect(props).toEqual(['path', 'query']);
    expect((tool!.inputSchema as any).required).toEqual(['path']);
  });

  it('says GET-only in its description', () => {
    const tool = setup().getToolsForContext('api')[0];
    expect(tool.description).toMatch(/GET/);
    expect(tool.description).toMatch(/read-only/i);
  });

  it('runs end to end through executeTool with the caller from the MCP layer', async () => {
    registerEndpoint('GET', '/disney-menus/status', (req, res) =>
      res.json({ who: req.authUser?.username }),
    );
    const result = await setup().executeTool(
      'darkride_api_get',
      { path: '/disney-menus/status' },
      new Set(['core.admin:*']),
      undefined,
      caller(['core.admin:*']),
    );
    expect(result).toEqual({ status: 200, body: { who: 'cube' } });
  });

  it('fails closed when executeTool is called without a caller', async () => {
    registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.json({}));
    await expect(
      setup().executeTool('darkride_api_get', { path: '/disney-menus/status' }),
    ).rejects.toThrow(/authenticated caller/i);
  });
});

describe('allow-list follows the route that will actually run', () => {
  beforeEach(() => {
    clearEndpoints();
  });

  it('treats the three core entries as exact paths, and /disney-menus as a prefix', () => {
    expect(isApiGetAllowed('/v1/plugins/list/scope-status')).toBe(false);
    expect(isApiGetAllowed('/v1/plugins/registry/uninstall-footprint')).toBe(false);
    expect(isApiGetAllowed('/v1/system/status/anything')).toBe(false);
    expect(isApiGetAllowed('/disney-menus/restaurants/32482')).toBe(true);
  });

  it('refuses a parameterised route that an allowed literal happens to match', async () => {
    const handler = vi.fn((_req, res) => res.json({ reached: true }));
    registerEndpoint('GET', '/v1/plugins/:name/scope-status', handler);
    const result = await runApiGet({ path: '/v1/plugins/list/scope-status' }, caller(['core.admin:*']));
    expect(result.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses when a wildcard route is registered ahead of the allowed literal one', async () => {
    const wildcard = vi.fn((_req, res) => res.json({ reached: 'wildcard' }));
    const literal = vi.fn((_req, res) => res.json({ reached: 'literal' }));
    registerEndpoint('GET', '/v1/:a/:b', wildcard);
    registerEndpoint('GET', '/v1/system/status', literal);
    const result = await runApiGet({ path: '/v1/system/status' }, caller());
    expect(result.status).toBe(403);
    expect(wildcard).not.toHaveBeenCalled();
    expect(literal).not.toHaveBeenCalled();
  });

  it('refuses an encoded path that only a parameterised route would accept', async () => {
    const handler = vi.fn((_req, res) => res.json({ reached: true }));
    registerEndpoint('GET', '/v1/:a/:b', handler);
    const result = await runApiGet({ path: '/v1/system/%73tatus' }, caller());
    expect(result.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('also applies the secret-word filter to the matched route pattern', async () => {
    // pathToRegex feeds the pattern straight into a RegExp, so one route can serve
    // a request that looks harmless while the same pattern also serves a token.
    const handler = vi.fn((_req, res) => res.json({ reached: true }));
    registerEndpoint('GET', '/disney-menus/:x/(token|status)', handler);
    const result = await runApiGet({ path: '/disney-menus/foo/status' }, caller());
    expect(result.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('still runs a parameterised route that sits under /disney-menus', async () => {
    registerEndpoint('GET', '/disney-menus/targets/:id', (req, res) => res.json({ id: req.params.id }));
    const result = await runApiGet({ path: '/disney-menus/targets/12' }, caller());
    expect(result).toEqual({ status: 200, body: { id: '12' } });
  });
});

describe('secret-looking words', () => {
  it.each([
    'credentials', 'credential', 'creds', 'cred',
    'secret', 'secrets', 'clientSecret', 'secretkey',
    'token', 'tokens', 'accessToken', 'authToken', 'tokenId',
    'password', 'passwords', 'passwd', 'pwd', 'passphrase',
    'api-key', 'api_key', 'apikey', 'apiKeys',
    'private-key', 'private_key', 'privatekey', 'signing-keys', 'keystore',
    'key', 'keys', 'id_rsa', 'pem', 'jwks',
    'oauth', 'oauth2', 'auth', 'authn', 'authorization', 'authenticate',
    'cert', 'certs', 'certificate', 'jwt', 'bearer',
    'cookie', 'cookies', 'session', 'sessions', 'swid',
  ])('refuses %s under an allowed prefix', (word) => {
    expect(isApiGetAllowed(`/disney-menus/${word}`)).toBe(false);
    expect(isApiGetAllowed(`/disney-menus/targets/12/${word}`)).toBe(false);
  });

  it('does not refuse the routes the tool exists for', () => {
    for (const p of [
      '/disney-menus/status',
      '/disney-menus/targets',
      '/disney-menus/targets/12',
      '/disney-menus/changes',
      '/disney-menus/restaurants/32482',
      '/v1/system/status',
      '/v1/plugins/list',
      '/v1/plugins/registry',
    ]) {
      expect(isApiGetAllowed(p), p).toBe(true);
    }
  });
});

describe('what the handler is given', () => {
  beforeEach(() => {
    clearEndpoints();
  });

  it('hands over the caller identity and a private copy of the scopes', async () => {
    let seen: any;
    registerEndpoint('GET', '/disney-menus/status', (req, res) => {
      seen = req.authUser;
      (req.authUser as any).effectiveScopes.add('handler:added');
      res.json({});
    });
    const who = caller(['a:b']);
    await runApiGet({ path: '/disney-menus/status' }, who);
    expect(seen).toMatchObject({ userId: 7, username: 'cube', via: 'oauth' });
    expect([...seen.effectiveScopes].sort()).toEqual(['a:b', 'handler:added']);
    expect(who.effectiveScopes.has('handler:added')).toBe(false);
  });

  it('puts the query in req.query, req.url and req.originalUrl', async () => {
    let seen: any;
    registerEndpoint('GET', '/disney-menus/targets', (req, res) => {
      seen = { query: req.query, url: req.url, originalUrl: req.originalUrl, path: req.path };
      res.json({});
    });
    await runApiGet(
      { path: '/disney-menus/targets', query: { status: 'failing', limit: 200, all: true } },
      caller(),
    );
    expect(seen.query).toEqual({ status: 'failing', limit: '200', all: 'true' });
    expect(seen.url).toBe('/disney-menus/targets?status=failing&limit=200&all=true');
    expect(seen.originalUrl).toBe(seen.url);
    expect(seen.path).toBe('/disney-menus/targets');
  });

  it.each([
    ['__proto__', JSON.parse('{"__proto__":"x"}')],
    ['constructor', { constructor: 'x' }],
    ['prototype', { prototype: 'x' }],
    ['an array', ['a']],
    ['a string', 'a=1'],
    ['a null value', { a: null }],
  ])('rejects a query that is %s', async (_label, query) => {
    registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.json({}));
    await expect(
      runApiGet({ path: '/disney-menus/status', query: query as any }, caller()),
    ).rejects.toThrow(/query/i);
  });

  it('treats a missing or null query as empty', async () => {
    let seen: any;
    registerEndpoint('GET', '/disney-menus/status', (req, res) => { seen = req.query; res.json({}); });
    await runApiGet({ path: '/disney-menus/status', query: null }, caller());
    expect(seen).toEqual({});
  });
});

describe('scopes with more than one requirement', () => {
  beforeEach(() => {
    clearEndpoints();
  });

  it('needs every scope, not any of them', async () => {
    const handler = vi.fn((_req, res) => res.json({ ok: true }));
    registerEndpoint('GET', '/disney-menus/status', handler, { requires: ['a:read', 'b:read'] });
    const partial = await runApiGet({ path: '/disney-menus/status' }, caller(['a:read']));
    expect(partial.status).toBe(403);
    expect((partial.body as any).missing).toEqual(['b:read']);
    expect(handler).not.toHaveBeenCalled();
    const full = await runApiGet({ path: '/disney-menus/status' }, caller(['a:read', 'b:read']));
    expect(full.status).toBe(200);
  });
});

describe('limits', () => {
  beforeEach(() => {
    clearEndpoints();
  });

  it('pins the documented numbers', () => {
    expect(API_GET_MAX_CHARS).toBe(60_000);
    expect(API_GET_TIMEOUT_MS).toBe(15_000);
  });

  it('cuts a body one character over the cap, with the marker and full size', async () => {
    registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.send('z'.repeat(60_001)));
    const result = await runApiGet({ path: '/disney-menus/status' }, caller());
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(60_001);
    expect(result.body).toBe(
      `${'z'.repeat(60_000)}\n[truncated: showing 60000 of 60001 characters]`,
    );
  });

  it('accepts a path of exactly 512 characters and rejects 513', () => {
    expect(validateApiGetPath('/' + 'a'.repeat(511)).ok).toBe(true);
    expect(validateApiGetPath('/' + 'a'.repeat(512)).ok).toBe(false);
  });

  it('keeps the first answer when a handler responds twice', async () => {
    registerEndpoint('GET', '/disney-menus/status', (_req, res) => {
      res.status(200).json({ first: true });
      res.status(500).json({ second: true });
    });
    expect(await runApiGet({ path: '/disney-menus/status' }, caller())).toEqual({
      status: 200,
      body: { first: true },
    });
  });
});

describe('unattended callers', () => {
  it('is blocked for unattended runs even when a caller is present', async () => {
    const registry = new AiToolRegistry();
    registerApiGetTool(registry);
    registerEndpoint('GET', '/disney-menus/status', (_req, res) => res.json({}));
    await expect(
      registry.executeTool('darkride_api_get', { path: '/disney-menus/status' }, new Set(['core.admin:*']), true, caller(['core.admin:*'])),
    ).rejects.toThrow();
  });
});
