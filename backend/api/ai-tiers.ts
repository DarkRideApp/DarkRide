import type { Request, Response, Router } from 'express';
import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { AiTierStore } from '../services/ai-tier-store';
import { aiModels } from '../db/schema';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export interface AiTiersRoutesDeps {
  tierStore: AiTierStore;
  db: BetterSQLite3Database<any>;
}

type Handler = (req: Request, res: Response) => void | Promise<void>;

function parseIntParam(req: Request, key: string): number | null {
  const n = Number(req.params[key]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function makeHandlers(deps: AiTiersRoutesDeps): Record<string, Handler> {
  const { tierStore, db } = deps;

  return {
    list: (_req, res) => {
      res.json(tierStore.list());
    },
    create: (req, res) => {
      const name = (req.body?.name ?? '').toString().trim();
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      try {
        res.status(201).json(tierStore.create(name));
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    },
    patch: (req, res) => {
      const id = parseIntParam(req, 'id');
      if (!id) { res.status(400).end(); return; }
      const body = req.body ?? {};
      if (typeof body.name === 'string') {
        try {
          res.json(tierStore.rename(id, body.name.trim()));
        } catch (err: any) {
          const code = /hardcoded/.test(err.message) ? 409 : 400;
          res.status(code).json({ error: err.message });
        }
      } else {
        res.status(400).json({ error: 'no changes provided' });
      }
    },
    reorder: (req, res) => {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((n: any) => Number(n)) : null;
      if (!ids) { res.status(400).json({ error: 'ids array is required' }); return; }
      try {
        tierStore.reorder(ids);
        res.status(204).end();
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    },
    delete: (req, res) => {
      const id = parseIntParam(req, 'id');
      if (!id) { res.status(400).end(); return; }
      try {
        tierStore.delete(id);
        res.status(204).end();
      } catch (err: any) {
        const code = /hardcoded|models|settings/.test(err.message) ? 409 : 400;
        res.status(code).json({ error: err.message });
      }
    },
    moveModelTier: (req, res) => {
      const id = parseIntParam(req, 'id');
      const tierId = Number(req.body?.tierId);
      if (!id || !Number.isFinite(tierId) || tierId <= 0) {
        res.status(400).json({ error: 'id and tierId are required' }); return;
      }
      if (!tierStore.getById(tierId)) {
        res.status(404).json({ error: 'tier not found' }); return;
      }
      db.update(aiModels).set({ tierId, updatedAt: new Date() as any })
        .where(eq(aiModels.id, id)).run();
      res.status(200).json({ ok: true });
    },
  };
}

export function registerAiTiersRoutes(deps: AiTiersRoutesDeps): void {
  const h = makeHandlers(deps);
  registerEndpoint('GET', '/v1/ai/tiers', h.list);
  registerEndpoint('POST', '/v1/ai/tiers', h.create);
  registerEndpoint('PUT', '/v1/ai/tiers/reorder', h.reorder);
  registerEndpoint('PATCH', '/v1/ai/tiers/:id', h.patch);
  registerEndpoint('DELETE', '/v1/ai/tiers/:id', h.delete);
  registerEndpoint('POST', '/v1/ai/models/:id/move-tier', h.moveModelTier);
}

export function mountAiTiersRoutesOnRouter(router: Router, deps: AiTiersRoutesDeps): void {
  const h = makeHandlers(deps);
  router.get('/v1/ai/tiers', h.list);
  router.post('/v1/ai/tiers', h.create);
  router.put('/v1/ai/tiers/reorder', h.reorder);
  router.patch('/v1/ai/tiers/:id', h.patch);
  router.delete('/v1/ai/tiers/:id', h.delete);
  router.post('/v1/ai/models/:id/move-tier', h.moveModelTier);
}
