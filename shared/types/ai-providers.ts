// ── AI Provider Types ────────────────────────────────────────────────

import { AI_PROVIDER_IDS, type AiProviderType as CatalogProviderType } from '../lib/ai-provider-catalog';

/** Derived from the provider catalog (`shared/lib/ai-provider-catalog.ts`). */
export type AiProviderType = CatalogProviderType;

/** Kept for existing importers; derived from the catalog. */
export const AI_PROVIDER_TYPES: AiProviderType[] = [...AI_PROVIDER_IDS];

// ── Response (credentials masked) ───────────────────────────────────

export interface AiProviderConfig {
  id: number;
  name: string;
  type: AiProviderType;
  hasApiKey: boolean;
  baseUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Create/Update requests ──────────────────────────────────────────

export interface CreateAiProviderRequest {
  name: string;
  type: AiProviderType;
  apiKey?: string;
  baseUrl?: string;
}

export interface UpdateAiProviderRequest {
  name?: string;
  type?: AiProviderType;
  apiKey?: string;
  baseUrl?: string | null;
}
