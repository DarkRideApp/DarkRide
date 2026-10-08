import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { aiProviders, aiModels } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { AiProviderConfig } from '../../shared/types/ai-providers';
import {
  AI_PROVIDER_IDS, getProviderDescriptor, isKnownProviderType, normalizeBaseUrl, sameEffectiveBaseUrl,
} from '../../shared/lib/ai-provider-catalog';
import { listModels, testProvider } from '../services/ai/provider-ops';
import type { RateLimitCache } from '../services/ai-model-router';

// C0 controls and DEL. A pasted key with an inner line break or NUL would make `fetch` reject the header.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Every real API key is printable ASCII. Anything else (an inner space, a zero-width or line-separator
// character picked up when copying, a C1 control, an emoji) fails every request later with an opaque
// "Cannot convert argument to a ByteString", so it is rejected on save with a message that says why.
const NON_PRINTABLE_ASCII = /[^\x21-\x7e]/;
const INVALID_TYPE = `Invalid type. Must be one of: ${AI_PROVIDER_IDS.join(', ')}`;

type Clean<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * undefined = not supplied (keep the stored key); '' = explicit clear (null is treated the same);
 * otherwise the trimmed key. Error messages never include the key itself.
 */
function cleanKey(raw: unknown): Clean<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: '' };
  if (typeof raw !== 'string') return { ok: false, error: 'apiKey must be a string' };
  const v = raw.trim();
  if (v === '') return { ok: false, error: 'API key is empty. Paste the key, or remove the saved one explicitly.' };
  if (CONTROL_CHARS.test(v)) return { ok: false, error: 'API key contains control characters. Re-copy it without line breaks.' };
  if (NON_PRINTABLE_ASCII.test(v)) {
    return {
      ok: false,
      error: 'API key contains spaces, invisible characters, or characters outside plain ASCII. Re-copy it from the provider.',
    };
  }
  return { ok: true, value: v };
}

/** A display name: a string, trimmed, non-empty. Shared with the model endpoints. */
export function cleanName(raw: unknown): Clean<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'name must be a non-empty string' };
  return { ok: true, value: raw.trim() };
}

/** A base URL in a request body is a string, null, or absent. Anything else would crash the normaliser. */
function baseUrlShapeError(raw: unknown): string | null {
  return raw === undefined || raw === null || typeof raw === 'string' ? null : 'baseUrl must be a string or null';
}

function providerToResponse(row: typeof aiProviders.$inferSelect): AiProviderConfig {
  return {
    id: row.id,
    name: row.name,
    type: row.type as AiProviderConfig['type'],
    hasApiKey: !!row.apiKey,
    baseUrl: row.baseUrl,
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
  };
}

/**
 * `rateLimitCache` is the router's cache, and it is required so that forgetting to wire it fails the type
 * check. Every successful PUT lifts the cooldowns of the provider's models: an auth failure cools down every
 * model on the credential, and a corrected key must work immediately rather than after the cooldown runs out.
 */
export function registerAiProviderEndpoints(db: AppDatabase, rateLimitCache: RateLimitCache): void {
  // GET /v1/ai/providers — list all (credentials masked)
  registerEndpoint('GET', '/v1/ai/providers', (_req, res) => {
    const providers = db.select().from(aiProviders).all();
    res.json({ success: true, data: providers.map(providerToResponse) });
  }, { requires: ['core.settings:read'] });

  // POST /v1/ai/providers — create
  registerEndpoint('POST', '/v1/ai/providers', (req, res) => {
    const { name, type, apiKey, baseUrl } = req.body;

    if (!name || !type) {
      res.status(400).json({ success: false, error: 'name and type are required' });
      return;
    }
    const cleanedName = cleanName(name);
    if (!cleanedName.ok) {
      res.status(400).json({ success: false, error: cleanedName.error });
      return;
    }
    if (!isKnownProviderType(type)) {
      res.status(400).json({ success: false, error: INVALID_TYPE });
      return;
    }
    const d = getProviderDescriptor(type)!;

    const key = cleanKey(apiKey);
    if (!key.ok) {
      res.status(400).json({ success: false, error: key.error });
      return;
    }

    const shapeError = baseUrlShapeError(baseUrl);
    if (shapeError) {
      res.status(400).json({ success: false, error: shapeError });
      return;
    }
    let storedUrl: string | null = null;
    if (d.baseUrl !== 'hidden') {
      const norm = normalizeBaseUrl(d, baseUrl);
      if (!norm.ok) {
        res.status(400).json({ success: false, error: norm.error });
        return;
      }
      if (d.baseUrl === 'required' && norm.url === null) {
        res.status(400).json({ success: false, error: `Base URL is required for ${d.label}` });
        return;
      }
      storedUrl = norm.url;
    }

    const now = new Date();
    const result = db.insert(aiProviders).values({
      name: cleanedName.value,
      type,
      apiKey: key.value || null,
      baseUrl: storedUrl,
      createdAt: now,
      updatedAt: now,
    }).run();

    const created = db.select().from(aiProviders).where(eq(aiProviders.id, Number(result.lastInsertRowid))).get();
    res.json({ success: true, data: created ? providerToResponse(created) : null });
  }, { requires: ['core.settings:write'] });

  // PUT /v1/ai/providers/:id — update
  registerEndpoint('PUT', '/v1/ai/providers/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!existing) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    const { name, type: newType, apiKey, baseUrl } = req.body;
    // Re-posting a stored type that was retired from the catalog is allowed, so such a row can still be renamed.
    if (newType !== undefined && newType !== existing.type && !isKnownProviderType(newType)) {
      res.status(400).json({ success: false, error: INVALID_TYPE });
      return;
    }
    const shapeError = baseUrlShapeError(baseUrl);
    if (shapeError) {
      res.status(400).json({ success: false, error: shapeError });
      return;
    }
    const type: string = newType !== undefined ? newType : existing.type;
    // Undefined only for a stored type that has since been retired from the catalog.
    const d = getProviderDescriptor(type);
    const typeChanged = type !== existing.type;
    const key = cleanKey(apiKey);
    if (!key.ok) {
      res.status(400).json({ success: false, error: key.error });
      return;
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (name !== undefined) {
      const cleanedName = cleanName(name);
      if (!cleanedName.ok) {
        res.status(400).json({ success: false, error: cleanedName.error });
        return;
      }
      updates.name = cleanedName.value;
    }
    if (newType !== undefined) updates.type = newType;

    // urlChanged means "requests would now go to a different host or path", which is what clears the key.
    let urlChanged = false;
    if (d) {
      if (d.baseUrl === 'hidden') {
        // This type never sends the URL anywhere, so dropping a stale value does not redirect the
        // credential and must not clear it.
        if (existing.baseUrl !== null) updates.baseUrl = null;
      } else {
        urlChanged = baseUrl !== undefined && !sameEffectiveBaseUrl(d, existing.baseUrl, baseUrl);
        // Validate only what the user changed: the form re-posts the stored URL on every edit, so an
        // unchanged legacy value must not block a rename. A type change re-checks the stored value
        // against the new descriptor.
        if (urlChanged || typeChanged) {
          const incoming = baseUrl !== undefined ? baseUrl : existing.baseUrl;
          const norm = normalizeBaseUrl(d, incoming);
          if (!norm.ok) {
            res.status(400).json({ success: false, error: norm.error });
            return;
          }
          if (d.baseUrl === 'required' && norm.url === null) {
            res.status(400).json({ success: false, error: `Base URL is required for ${d.label}` });
            return;
          }
          updates.baseUrl = norm.url;
        }
      }
    } else if (baseUrl !== undefined) {
      // Retired type: no catalog rules apply, store as given. Nothing can send requests for this type,
      // but a changed value still clears the key so the rule stays uniform.
      const next = (typeof baseUrl === 'string' && baseUrl.trim()) || null;
      urlChanged = next !== ((existing.baseUrl ?? '').trim() || null);
      updates.baseUrl = next;
    }

    if (key.value !== undefined) updates.apiKey = key.value === '' ? null : key.value;
    else if (typeChanged || urlChanged) updates.apiKey = null; // a credential must not follow a redirected destination

    db.update(aiProviders).set(updates).where(eq(aiProviders.id, id)).run();

    // If type changed, sync the denormalized provider string on linked models
    if (newType !== undefined) {
      db.update(aiModels)
        .set({ provider: newType, updatedAt: new Date() })
        .where(eq(aiModels.providerId, id))
        .run();
    }

    // On every successful save, not only on a key change: cheap, and a type or URL fix can cure an auth
    // failure just as a new key can.
    const modelIds = db.select({ id: aiModels.id }).from(aiModels).where(eq(aiModels.providerId, id)).all().map((m) => m.id);
    if (modelIds.length > 0) rateLimitCache.clear(modelIds);

    const updated = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    res.json({ success: true, data: updated ? providerToResponse(updated) : null });
  }, { requires: ['core.settings:write'] });

  // DELETE /v1/ai/providers/:id — delete (reject if models reference it)
  registerEndpoint('DELETE', '/v1/ai/providers/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const existing = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!existing) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    // Check if any models reference this provider
    const linkedModels = db.select().from(aiModels).where(eq(aiModels.providerId, id)).all();
    if (linkedModels.length > 0) {
      res.status(409).json({
        success: false,
        error: `Cannot delete provider: ${linkedModels.length} model(s) still reference it`,
      });
      return;
    }

    db.delete(aiProviders).where(eq(aiProviders.id, id)).run();
    res.json({ success: true });
  }, { requires: ['core.settings:write'] });

  // GET /v1/ai/providers/:id/models — list available models from provider
  registerEndpoint('GET', '/v1/ai/providers/:id/models', async (req, res) => {
    const id = parseInt(req.params.id);
    const provider = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    try {
      const models = await listModels(provider);
      res.json({ success: true, data: models });
    } catch (err: any) {
      res.json({ success: false, error: err?.message || 'Failed to fetch models', data: [] });
    }
  }, { requires: ['core.settings:read'] });

  // POST /v1/ai/providers/:id/test — test connection
  registerEndpoint('POST', '/v1/ai/providers/:id/test', async (req, res) => {
    const id = parseInt(req.params.id);
    const provider = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
    if (!provider) {
      res.status(404).json({ success: false, error: 'Provider not found' });
      return;
    }

    try {
      res.json(await testProvider(provider));
    } catch (err: any) {
      res.json({ success: false, error: err?.message || 'Unknown error' });
    }
  }, { requires: ['core.settings:write'] });
}
