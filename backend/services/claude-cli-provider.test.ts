import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { ApiKeyManager } from '../auth/api-key-manager';
import { ClaudeCliProvider } from './claude-cli-provider';
import type { AgentIdentity } from './ai-agent';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stub child_process.spawn so sendMessage tests don't actually run the claude CLI.
// vi.hoisted lets us reference the same vi.fn from both the mock factory and
// individual tests (for mockImplementationOnce overrides).
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: spawnMock };
});

// Default behaviour: child closes with exit 0 after a tick.
function makeDefaultChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  child.killed = false;
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
  });
  return child;
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeProvider(
  db: BetterSQLite3Database<typeof schema>,
  apiKeyMgr: ApiKeyManager,
  baseDir: string,
): ClaudeCliProvider {
  // We construct a provider with a dummy mcpConfigPath; the tests don't spawn processes.
  // Override DATA_DIR-based config path by providing a tempdir-based port 0 setup.
  // We pass port=9999 so writeMcpConfigForSpawn writes to baseDir (DATA_DIR is internal).
  // Instead, we'll create the provider normally and rely on mintEphemeralTokenForIdentity
  // writing to the real DATA_DIR path — we just verify the returned configPath contains sessionId.
  return new ClaudeCliProvider(
    join(baseDir, 'mcp-config.json'),
    undefined,
    db as any,
    apiKeyMgr,
    9999,
  );
}

function insertUser(
  db: BetterSQLite3Database<typeof schema>,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): number {
  const now = new Date();
  return db
    .insert(schema.users)
    .values({
      username: `user-${Date.now()}-${Math.random()}`,
      providerId: 'core.password',
      scopes: [] as any,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as any)
    .returning({ id: schema.users.id })
    .get().id;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('ClaudeCliProvider', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let apiKeyMgr: ApiKeyManager;
  let provider: ClaudeCliProvider;
  let baseDir: string;

  beforeEach(() => {
    db = createTestDb();
    apiKeyMgr = new ApiKeyManager(db as any);
    baseDir = mkdtempSync(join(tmpdir(), 'cli-provider-test-'));
    provider = makeProvider(db, apiKeyMgr, baseDir);
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeDefaultChild());
  });

  describe('mintEphemeralToken', () => {
    it('mints an internal PAT with the user scopes and writes a config file', () => {
      const userId = insertUser(db, { scopes: ['core.apk:read', 'mcp'] as any });

      const { keyId, configPath } = provider.mintEphemeralToken(userId, 'sess-legacy');

      const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId)).get();
      expect(row).toBeDefined();
      expect(row!.userId).toBe(userId);
      expect(row!.internal).toBe(true);
      // scopes may come back as a parsed array or JSON string depending on the driver mode
      const scopes = Array.isArray(row!.scopes) ? row!.scopes : JSON.parse(row!.scopes as any);
      expect(scopes).toEqual(['core.apk:read', 'mcp']);
      expect(configPath).toMatch(/sess-legacy/);
    });

    it('throws when the user does not exist', () => {
      expect(() => provider.mintEphemeralToken(999999, 'sess-x')).toThrow(/user.*not found/i);
    });
  });

  describe('mintEphemeralTokenForIdentity', () => {
    it('mints a PAT with identity.effectiveScopes owned by identity.actorUserId', () => {
      const now = new Date();
      const pluginSvcUserId = db
        .insert(schema.users)
        .values({
          username: 'plugin:apk-diff-engine:ai',
          providerId: 'core.service',
          kind: 'plugin-service',
          serviceOwner: 'apk-diff-engine',
          scopes: ['core.apk:read'] as any,
          createdAt: now,
          updatedAt: now,
        } as any)
        .returning({ id: schema.users.id })
        .get().id;

      const identity: AgentIdentity = {
        identityType: 'plugin',
        actorUserId: pluginSvcUserId,
        effectiveScopes: ['core.apk:read'],
        onBehalfOfPlugin: 'apk-diff-engine',
      };

      const { keyId, configPath } = provider.mintEphemeralTokenForIdentity(identity, 'sess-1');

      const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId)).get();
      expect(row).toBeDefined();
      expect(row!.userId).toBe(pluginSvcUserId);
      // scopes may come back as a parsed array or JSON string depending on the driver mode
      const scopes = Array.isArray(row!.scopes) ? row!.scopes : JSON.parse(row!.scopes as any);
      expect(scopes).toEqual(['core.apk:read']);
      expect(row!.internal).toBe(true);
      expect(configPath).toMatch(/sess-1/);
    });

    it('names the key according to identity type', () => {
      const now = new Date();
      const userId = insertUser(db, {
        username: 'alice',
        providerId: 'core.password',
        scopes: [] as any,
        createdAt: now,
        updatedAt: now,
      });

      // 'user' identity type
      const userIdentity: AgentIdentity = {
        identityType: 'user',
        actorUserId: userId,
        effectiveScopes: [],
      };
      const { keyId: k1 } = provider.mintEphemeralTokenForIdentity(userIdentity, 'u');
      const uRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, k1)).get();
      expect(uRow!.name).toMatch(/AI Assistant/);

      // 'plugin' identity type
      const pluginIdentity: AgentIdentity = {
        identityType: 'plugin',
        actorUserId: userId,
        effectiveScopes: [],
        onBehalfOfPlugin: 'foo',
      };
      const { keyId: k2 } = provider.mintEphemeralTokenForIdentity(pluginIdentity, 'p');
      const pRow = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, k2)).get();
      expect(pRow!.name).toMatch(/Plugin foo/);
    });

    it('uses a unique configPath per sessionId', () => {
      const userId = insertUser(db, { scopes: [] as any });
      const identity: AgentIdentity = {
        identityType: 'user',
        actorUserId: userId,
        effectiveScopes: [],
      };

      const { configPath: p1 } = provider.mintEphemeralTokenForIdentity(identity, 'sess-a');
      const { configPath: p2 } = provider.mintEphemeralTokenForIdentity(identity, 'sess-b');
      expect(p1).not.toBe(p2);
      expect(p1).toMatch(/sess-a/);
      expect(p2).toMatch(/sess-b/);
    });
  });

  describe('sendMessage self-heal: stale --resume', () => {
    // Helper that builds a fake child process. `behaviour` controls what the
    // CLI "does" before close — either silently exit (mimicking the stale-resume
    // failure pattern: exit 1, no stream output, empty stderr) or emit a normal
    // assistant result line before exiting 0.
    function makeFakeChild(behaviour: 'stale-resume-exit-1' | 'normal-exit-0') {
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      child.killed = false;
      setImmediate(() => {
        if (behaviour === 'normal-exit-0') {
          // Emit a minimal stream-json result event so numTurns > 0
          const resultEvent = JSON.stringify({
            type: 'result',
            session_id: 'fresh-session-uuid',
            usage: { input_tokens: 10, output_tokens: 5 },
            total_cost_usd: 0.01,
            num_turns: 1,
          });
          child.stdout.write(resultEvent + '\n');
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('close', behaviour === 'normal-exit-0' ? 0 : 1);
      });
      return child;
    }

    it('retries without --resume when CLI exits 1 with zero turns after --resume', async () => {
      const spawnArgs: Array<ReadonlyArray<string>> = [];

      // First spawn: stale resume — exit 1, zero turns, empty stderr
      spawnMock.mockImplementationOnce(((_cmd: string, args: readonly string[]) => {
        spawnArgs.push(args);
        return makeFakeChild('stale-resume-exit-1');
      }) as any);

      // Second spawn (retry): clean exit
      spawnMock.mockImplementationOnce(((_cmd: string, args: readonly string[]) => {
        spawnArgs.push(args);
        return makeFakeChild('normal-exit-0');
      }) as any);

      const callbacks = {
        onText: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onUsage: vi.fn(),
        onSessionInit: vi.fn(),
      };

      const result = await provider.sendMessage('hi', callbacks, { sessionId: 'stale-uuid' });

      expect(spawnArgs.length).toBe(2);
      // First spawn carried --resume stale-uuid
      expect(spawnArgs[0]).toContain('--resume');
      expect(spawnArgs[0]).toContain('stale-uuid');
      // Retry omits --resume entirely
      expect(spawnArgs[1]).not.toContain('--resume');
      expect(spawnArgs[1]).not.toContain('stale-uuid');
      // Final result is the retry's success
      expect(result.error).toBeUndefined();
      expect(result.numTurns).toBe(1);
      expect(result.sessionId).toBe('fresh-session-uuid');
    });

    it('does not retry when --resume was not used in the first place', async () => {
      const spawnArgs: Array<ReadonlyArray<string>> = [];

      // Single spawn: exit 1, no retry expected (no --resume was passed)
      spawnMock.mockImplementationOnce(((_cmd: string, args: readonly string[]) => {
        spawnArgs.push(args);
        return makeFakeChild('stale-resume-exit-1');
      }) as any);

      const callbacks = {
        onText: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onUsage: vi.fn(),
        onSessionInit: vi.fn(),
      };

      const result = await provider.sendMessage('hi', callbacks, {});

      expect(spawnArgs.length).toBe(1);
      expect(spawnArgs[0]).not.toContain('--resume');
      expect(result.error).toBeDefined();
    });

    it('does not retry when the failing attempt produced turns', async () => {
      // Mimics a real CLI error mid-conversation (e.g. token budget, model error)
      // rather than the stale-resume silent-bail pattern.
      const spawnArgs: Array<ReadonlyArray<string>> = [];

      spawnMock.mockImplementationOnce(((_cmd: string, args: readonly string[]) => {
        spawnArgs.push(args);
        const child: any = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn();
        child.killed = false;
        setImmediate(() => {
          // Result event with num_turns=2 — real progress was made
          child.stdout.write(JSON.stringify({
            type: 'result',
            session_id: 'sess-mid-error',
            usage: { input_tokens: 100, output_tokens: 50 },
            total_cost_usd: 0.05,
            num_turns: 2,
          }) + '\n');
          child.stdout.end();
          child.stderr.write('Model returned an error');
          child.stderr.end();
          child.emit('close', 1);
        });
        return child;
      }) as any);

      const callbacks = {
        onText: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onUsage: vi.fn(),
        onSessionInit: vi.fn(),
      };

      const result = await provider.sendMessage('hi', callbacks, { sessionId: 'real-session' });

      // Only one spawn — turns > 0 means this isn't the stale-resume pattern
      expect(spawnArgs.length).toBe(1);
      expect(result.error).toBeDefined();
      expect(result.numTurns).toBe(2);
    });
  });

  describe('setOauthToken clears stale claude_session_id values', () => {
    function insertConversation(claudeSessionId: string | null): number {
      const now = new Date();
      return db
        .insert(schema.aiConversations)
        .values({
          pageContext: 'test',
          contextId: '',
          title: 'test',
          messages: '[]',
          inputTokens: 0,
          outputTokens: 0,
          claudeSessionId: claudeSessionId as any,
          createdAt: now,
          updatedAt: now,
        } as any)
        .returning({ id: schema.aiConversations.id })
        .get().id;
    }

    it('clears all claude_session_id rows when the token value changes', () => {
      const a = insertConversation('sess-aaa');
      const b = insertConversation('sess-bbb');
      const c = insertConversation(null); // already null — must stay null
      const fresh = new ClaudeCliProvider(
        join(baseDir, 'mcp-config.json'),
        'old-token',
        db as any,
        apiKeyMgr,
        9999,
      );

      fresh.setOauthToken('new-token');

      const rows = db.select().from(schema.aiConversations).all();
      const byId = new Map(rows.map(r => [r.id, r.claudeSessionId]));
      expect(byId.get(a)).toBeNull();
      expect(byId.get(b)).toBeNull();
      expect(byId.get(c)).toBeNull();
    });

    it('is a no-op when the token value is unchanged', () => {
      insertConversation('sess-keep');
      const fresh = new ClaudeCliProvider(
        join(baseDir, 'mcp-config.json'),
        'same-token',
        db as any,
        apiKeyMgr,
        9999,
      );

      fresh.setOauthToken('same-token');

      const row = db.select().from(schema.aiConversations).all()[0];
      expect(row.claudeSessionId).toBe('sess-keep');
    });

    it('clears on undefined → string transition (token first set)', () => {
      insertConversation('sess-initial');
      const fresh = new ClaudeCliProvider(
        join(baseDir, 'mcp-config.json'),
        undefined,
        db as any,
        apiKeyMgr,
        9999,
      );

      fresh.setOauthToken('first-token');

      const row = db.select().from(schema.aiConversations).all()[0];
      expect(row.claudeSessionId).toBeNull();
    });

    it('clears on string → undefined transition (token removed)', () => {
      insertConversation('sess-last');
      const fresh = new ClaudeCliProvider(
        join(baseDir, 'mcp-config.json'),
        'going-away',
        db as any,
        apiKeyMgr,
        9999,
      );

      fresh.setOauthToken(undefined);

      const row = db.select().from(schema.aiConversations).all()[0];
      expect(row.claudeSessionId).toBeNull();
    });
  });

  describe('sendMessage with identity', () => {
    it('mints a PAT from identity.effectiveScopes attributed to identity.actorUserId', async () => {
      const now = new Date();
      const pluginSvcUserId = db
        .insert(schema.users)
        .values({
          username: 'plugin:example:ai',
          providerId: 'core.service',
          kind: 'plugin-service',
          serviceOwner: 'example',
          scopes: ['core.apk:read', 'mcp'] as any,
          createdAt: now,
          updatedAt: now,
        } as any)
        .returning({ id: schema.users.id })
        .get().id;

      const identity: AgentIdentity = {
        identityType: 'plugin',
        actorUserId: pluginSvcUserId,
        effectiveScopes: ['core.apk:read'], // narrower than the user row's scopes
        onBehalfOfPlugin: 'example',
      };

      const callbacks = {
        onText: vi.fn(),
        onToolStart: vi.fn(),
        onToolResult: vi.fn(),
        onUsage: vi.fn(),
        onSessionInit: vi.fn(),
      };

      await provider.sendMessage('hello', callbacks, {
        sessionId: 'identity-session',
        identity,
      });

      // Find the minted api_keys row — even though the fake spawn causes sendMessage
      // to revoke on close, the row remains in the DB with revokedAt set.
      const rows = db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.userId, pluginSvcUserId))
        .all();
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row.userId).toBe(pluginSvcUserId);
      expect(row.internal).toBe(true);
      expect(row.name).toMatch(/Plugin example/);
      const scopes = Array.isArray(row.scopes) ? row.scopes : JSON.parse(row.scopes as any);
      expect(scopes).toEqual(['core.apk:read']); // identity scopes, NOT the user row's wider scopes
    });

  });
});
