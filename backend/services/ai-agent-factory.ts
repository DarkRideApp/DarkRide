import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { users } from '../db/schema';
import type { ServiceUserManager } from '../auth/service-user-manager';
import type { ApiKeyManager } from '../auth/api-key-manager';
import {
  getRunUsageFromError,
  type AiAgentInterface,
  type AgentIdentity,
  type AgentRequestUsage,
  type HandleMessageParams,
  type HandleMessageResult,
} from './ai-agent';
import { CORE_SERVICE_IDENTITIES, type CoreServiceKey } from './core-service-identities';
import { scopeIntersect } from '../auth/scope-matcher';

// Some callers (bootstrap, claim-manager, system-user, api-key-manager,
// admin-users) pre-stringify scopes before Drizzle's mode:'json' stringifies
// them again, leaving the DB row double-encoded. Drizzle parses once on read
// so those rows surface as a JSON string instead of an array. Middleware
// handles this defensively; mirror that here so we never hand a raw string
// to downstream code that expects a string[].
function coerceScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string' && raw.length > 0) {
    try { return JSON.parse(raw) as string[]; }
    catch { return []; }
  }
  return [];
}

function sum(requests: AgentRequestUsage[], key: 'inputTokens' | 'outputTokens'): number {
  return requests.reduce((n, r) => n + r[key], 0);
}

export interface AiCallLoggerLike {
  startCall(identity: AgentIdentity, params: Partial<HandleMessageParams>): number;
  endCall(
    logId: number,
    outcome: 'success' | 'error' | 'aborted',
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      turns?: number;
      toolCalls?: number;
      costUsd?: number;
      /** Every model request of the run, in order; the logger prices each one. */
      requests?: AgentRequestUsage[];
    },
    error?: string,
  ): void;
}

export interface BoundAgent {
  readonly identity: AgentIdentity;
  handleMessage(params: HandleMessageParams): Promise<HandleMessageResult>;
}

export interface AiAgentFactoryDeps {
  db: BetterSQLite3Database<any>;
  serviceUsers: ServiceUserManager;
  apiKeys: ApiKeyManager;
  providerFactory: (options?: { tier?: string }) => AiAgentInterface | null;
  logger: AiCallLoggerLike;
}

export class AiAgentFactory {
  private registeredCore = new Set<CoreServiceKey>();

  constructor(private deps: AiAgentFactoryDeps) {}

  forUser(userId: number, options?: { tier?: string }): BoundAgent {
    const user = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new Error(`forUser: user ${userId} not found`);
    if (user.kind !== 'human') {
      throw new Error(`forUser: user ${userId} is a ${user.kind} account, not a human`);
    }
    const scopes = coerceScopes(user.scopes);
    return this.wrap({
      identityType: 'user',
      actorUserId: userId,
      effectiveScopes: scopes,
    }, options);
  }

  forCoreService<K extends CoreServiceKey>(key: K, options?: { tier?: string }): BoundAgent {
    if (!this.registeredCore.has(key)) {
      throw new Error(
        `forCoreService: "${key}" is not registered. ` +
        `Call aiFactory.registerCoreIdentity(key, { aiScopes }) at boot.`,
      );
    }
    const svcUser = this.deps.serviceUsers.getCoreServiceUser(key);
    if (!svcUser) throw new Error(`forCoreService: "${key}" registered but no service user found`);
    return this.wrap({
      identityType: 'core-service',
      actorUserId: svcUser.id,
      effectiveScopes: coerceScopes(svcUser.scopes),
      onBehalfOfService: key,
    }, options);
  }

  registerCoreIdentity(name: string, opts: { aiScopes: string[] }): void {
    if (!(CORE_SERVICE_IDENTITIES as readonly string[]).includes(name)) {
      throw new Error(
        `registerCoreIdentity: "${name}" is not in CORE_SERVICE_IDENTITIES. Add it to backend/services/core-service-identities.ts first.`,
      );
    }
    this.deps.serviceUsers.ensureCoreServiceUser(name, opts.aiScopes);
    this.registeredCore.add(name as CoreServiceKey);
  }

  /**
   * Framework-internal: produce a plugin-bound agent for ctx.ai.agent().
   * The plugin must already have its service user provisioned (post-consent).
   */
  forPluginInternal(pluginName: string, aiScopes: string[], options?: { tier?: string }): BoundAgent {
    const svcUser = this.deps.serviceUsers.getPluginServiceUser(pluginName);
    if (!svcUser) {
      throw new Error(
        `Plugin "${pluginName}" has no service user. aiScopes may be empty or install not consented.`,
      );
    }
    return this.wrap({
      identityType: 'plugin',
      actorUserId: svcUser.id,
      effectiveScopes: aiScopes,
      onBehalfOfPlugin: pluginName,
    }, options);
  }

  /**
   * Framework-internal: produce an intersected agent for ctx.ai.forUser(uid).
   * Effective scopes = user's live scopes ∩ plugin's declared aiScopes.
   */
  forPluginActingForInternal(
    pluginName: string,
    userId: number,
    aiScopes: string[],
    options?: { tier?: string },
  ): BoundAgent {
    const user = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user || user.kind !== 'human') {
      throw new Error(`forPluginActingForInternal: user ${userId} missing or not human`);
    }
    const userScopes = new Set(coerceScopes(user.scopes));
    const effective = scopeIntersect(userScopes, aiScopes);
    return this.wrap({
      identityType: 'plugin-acting-for-user',
      actorUserId: userId,
      effectiveScopes: effective,
      onBehalfOfPlugin: pluginName,
      actingForUserId: userId,
    }, options);
  }

  private wrap(identity: AgentIdentity, options?: { tier?: string }): BoundAgent {
    const deps = this.deps;
    return {
      identity,
      async handleMessage(params: HandleMessageParams): Promise<HandleMessageResult> {
        const provider = deps.providerFactory(options);
        if (!provider) throw new Error('No AI provider configured');
        const logId = deps.logger.startCall(identity, params);
        let result: HandleMessageResult;
        try {
          result = await provider.handleMessageWithIdentity(identity, params);
        } catch (err) {
          // A run that throws still paid for the requests it made before failing.
          const partial = getRunUsageFromError(err);
          deps.logger.endCall(
            logId,
            'error',
            partial
              ? {
                inputTokens: sum(partial.requests, 'inputTokens'),
                outputTokens: sum(partial.requests, 'outputTokens'),
                requests: partial.requests,
                turns: partial.turns,
                toolCalls: partial.toolCalls,
              }
              : undefined,
            String(err),
          );
          throw err;
        }
        deps.logger.endCall(
          logId,
          result.aborted ? 'aborted' : result.error ? 'error' : 'success',
          result.usage || result.run
            ? {
              inputTokens: result.usage?.inputTokens,
              outputTokens: result.usage?.outputTokens,
              requests: result.run?.requests,
              turns: result.run?.turns,
              toolCalls: result.run?.toolCalls,
            }
            : undefined,
          result.error,
        );
        return result;
      },
    };
  }
}
