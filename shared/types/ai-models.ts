// ── AI Model Config (returned from API, credentials via provider) ────

export interface AiModelConfig {
  id: number;
  name: string;
  provider: string;
  providerId: number | null;
  providerName: string | null;
  model: string | null;
  enabled: boolean;
  priority: number;
  cooldownMinutes: number;
  tierId: number | null;
  tierName: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Rate limit info ─────────────────────────────────────────────────

export interface AiRateLimitInfo {
  modelId: number;
  modelName: string;
  provider: string;
  inCooldown: boolean;
  cooldownEndsAt: number | null;
  requestsLimit: number | null;
  requestsRemaining: number | null;
  requestsReset: string | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
  tokensReset: string | null;
}

// ── Create/Update requests ──────────────────────────────────────────

export interface CreateAiModelRequest {
  name: string;
  providerId: number;
  model?: string;
  enabled?: boolean;
  cooldownMinutes?: number;
  tierId?: number;
}

export interface UpdateAiModelRequest {
  name?: string;
  providerId?: number;
  model?: string | null;
  enabled?: boolean;
  cooldownMinutes?: number;
  tierId?: number;
}

export interface ReorderAiModelsRequest {
  ids: number[];
}
