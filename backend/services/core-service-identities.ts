/**
 * Central registry of core (in-tree) services that use AI.
 * The derived `CoreServiceKey` type is used by AiAgentFactory.forCoreService
 * so typos at call sites fail compilation.
 *
 * Adding a new core service: append the key here and register its aiScopes
 * via aiFactory.registerCoreIdentity(...) at boot in backend/index.ts.
 */
export const CORE_SERVICE_IDENTITIES = Object.freeze([
  'apk-analyzer',
  'apk-diff-engine',
] as const);

export type CoreServiceKey = (typeof CORE_SERVICE_IDENTITIES)[number];
