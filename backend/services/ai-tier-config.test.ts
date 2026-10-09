import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as schema from '../db/schema';
import { createTestDb } from '../test-utils/create-test-db';
import { AiModelRouter, RateLimitCache } from './ai-model-router';
import { ModelRefusedError } from './ai/errors';
import { resolveTierConfig } from './ai-tier-config';

vi.mock('../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: vi.fn() }) }));

const { aiModels, aiProviders, aiTiers } = schema;

type Db = ReturnType<typeof createTestDb>;

function addTier(db: Db, name: string, sortOrder: number): number {
  return Number(db.insert(aiTiers).values({ name, sortOrder, isHardcoded: true, createdAt: 1, updatedAt: 1 }).run().lastInsertRowid);
}
function addProvider(db: Db, type = 'anthropic'): number {
  const now = new Date();
  return Number(db.insert(aiProviders).values({ name: type, type, apiKey: type === 'claude-cli' ? null : 'sk-test', createdAt: now, updatedAt: now }).run().lastInsertRowid);
}
function addModel(db: Db, name: string, tierId: number, providerId: number, providerType: string, priority = 0): void {
  const now = new Date();
  db.insert(aiModels).values({ name, model: name, provider: providerType, providerId, tierId, priority, createdAt: now, updatedAt: now }).run();
}

describe('resolveTierConfig', () => {
  let db: Db;
  let high: number;
  let low: number;
  let calls: string[];
  let refuses: Set<string>;
  let router: AiModelRouter;

  beforeEach(() => {
    db = createTestDb();
    high = addTier(db, 'High', 0);
    low = addTier(db, 'Low', 1);
    calls = [];
    refuses = new Set();
    router = new AiModelRouter(db as any, new RateLimitCache(), {
      providerFactory: ((_type: string, cfg: any) => ({
        name: 'x',
        createStreamingRequest: async function* () {
          calls.push(cfg.model);
          if (refuses.has(cfg.model)) throw new ModelRefusedError(`${cfg.model} declined this request (category: cyber).`, { provider: 'anthropic' });
          yield { type: 'text' as const, text: `from ${cfg.model}` };
        },
      })) as any,
    });
  });

  const drain = async (stream: AsyncIterable<any>) => {
    const out: any[] = [];
    for await (const e of stream) out.push(e);
    return out;
  };

  it('returns null when no model is configured at all', () => {
    expect(resolveTierConfig(router, { research: 'Low', write: 'High' }, ['patch_analysis_section'])).toBeNull();
  });

  it('serves an empty tier from the nearest tier that has models', async () => {
    const p = addProvider(db);
    addModel(db, 'Opus', high, p, 'anthropic');
    const cfg = resolveTierConfig(router, { research: 'Low', write: 'High' }, ['patch_analysis_section'])!;
    expect(await drain(cfg.researchProvider.createStreamingRequest([], '', []))).toEqual([{ type: 'text', text: 'from Opus' }]);
  });

  it('returns null when the top model of a tier runs through the CLI, which cannot do tiered streaming', () => {
    const cli = addProvider(db, 'claude-cli');
    const api = addProvider(db);
    addModel(db, 'CLI Opus', high, cli, 'claude-cli', 0);
    addModel(db, 'Haiku', low, api, 'anthropic', 0);
    expect(resolveTierConfig(router, { research: 'Low', write: 'High' }, ['patch_analysis_section'])).toBeNull();
  });

  it('carries the write tool names through', () => {
    const p = addProvider(db);
    addModel(db, 'Opus', high, p, 'anthropic');
    const cfg = resolveTierConfig(router, { research: 'High', write: 'High' }, ['patch_analysis_section', 'write_analysis_notes'])!;
    expect(cfg.writeToolNames).toEqual(['patch_analysis_section', 'write_analysis_notes']);
  });

  it('both providers fall back past a model that refuses, instead of pinning the top model of the tier', async () => {
    const p = addProvider(db);
    addModel(db, 'Opus', high, p, 'anthropic', 0);
    addModel(db, 'Backup', high, p, 'anthropic', 1);
    refuses.add('Opus');
    const cfg = resolveTierConfig(router, { research: 'High', write: 'High' }, ['patch_analysis_section'])!;

    expect(await drain(cfg.researchProvider.createStreamingRequest([], '', []))).toEqual([{ type: 'text', text: 'from Backup' }]);
    expect(await drain(cfg.writeProvider.createStreamingRequest([], '', []))).toEqual([{ type: 'text', text: 'from Backup' }]);
    // Opus refused the research request, so the write request of the same run does not ask it again.
    expect(calls).toEqual(['Opus', 'Backup', 'Backup']);
  });

  it('a new run starts over: a model that refused earlier is tried again', async () => {
    const p = addProvider(db);
    addModel(db, 'Opus', high, p, 'anthropic', 0);
    addModel(db, 'Backup', high, p, 'anthropic', 1);
    refuses.add('Opus');
    const first = resolveTierConfig(router, { research: 'High', write: 'High' }, ['patch_analysis_section'])!;
    await drain(first.researchProvider.createStreamingRequest([], '', []));
    refuses.delete('Opus');
    const second = resolveTierConfig(router, { research: 'High', write: 'High' }, ['patch_analysis_section'])!;
    expect(await drain(second.researchProvider.createStreamingRequest([], '', []))).toEqual([{ type: 'text', text: 'from Opus' }]);
  });

  it('each provider serves from its own tier', async () => {
    const p = addProvider(db);
    addModel(db, 'Opus', high, p, 'anthropic');
    addModel(db, 'Haiku', low, p, 'anthropic');
    const cfg = resolveTierConfig(router, { research: 'Low', write: 'High' }, ['patch_analysis_section'])!;

    expect(await drain(cfg.researchProvider.createStreamingRequest([], '', []))).toEqual([{ type: 'text', text: 'from Haiku' }]);
    expect(await drain(cfg.writeProvider.createStreamingRequest([], '', []))).toEqual([{ type: 'text', text: 'from Opus' }]);
  });

  it('when every model of the tier refuses, the refusal itself reaches the caller', async () => {
    const p = addProvider(db);
    addModel(db, 'Opus', high, p, 'anthropic', 0);
    addModel(db, 'Backup', high, p, 'anthropic', 1);
    refuses.add('Opus');
    refuses.add('Backup');
    const cfg = resolveTierConfig(router, { research: 'High', write: 'High' }, ['patch_analysis_section'])!;
    const err: any = await drain(cfg.writeProvider.createStreamingRequest([], '', [])).catch((e) => e);
    expect(err).toBeInstanceOf(ModelRefusedError);
    expect(err.message).toBe('Opus declined this request (category: cyber).');
  });
});
