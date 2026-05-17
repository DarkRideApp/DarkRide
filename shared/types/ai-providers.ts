// ── AI Provider Types ────────────────────────────────────────────────

export type AiProviderType = 'anthropic' | 'gemini' | 'ollama' | 'openrouter' | 'codestral' | 'claude-cli';

export const AI_PROVIDER_TYPES: AiProviderType[] = [
  'anthropic', 'gemini', 'ollama', 'openrouter', 'codestral', 'claude-cli',
];

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
