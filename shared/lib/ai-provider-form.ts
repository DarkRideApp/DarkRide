// Pure derivation of the provider settings form from the provider catalog.
// No React, Node or backend imports: the frontend imports this file.
import {
  AI_PROVIDER_CATALOG, getProviderDescriptor, normalizeBaseUrl, type AiProviderType,
} from './ai-provider-catalog';

export interface ProviderFormShape {
  showKey: boolean;
  keyLabel: string;
  keyRequired: boolean;
  keyPlaceholder?: string;
  keyTestId: 'provider-api-key-input' | 'provider-oauth-token-input';
  showBaseUrl: boolean;
  baseUrlRequired: boolean;
  baseUrlPlaceholder: string;
  isCli: boolean;
  modelRequired: boolean;
}

/** Shape for a stored type the catalog no longer knows: show everything, require nothing. */
const PERMISSIVE: ProviderFormShape = {
  showKey: true, keyLabel: 'API Key', keyRequired: false, keyTestId: 'provider-api-key-input',
  showBaseUrl: true, baseUrlRequired: false, baseUrlPlaceholder: '', isCli: false, modelRequired: false,
};

export function providerFormShape(typeId: string): ProviderFormShape {
  const d = getProviderDescriptor(typeId);
  if (!d) return PERMISSIVE;
  const isCli = d.kind === 'cli';
  return {
    showKey: d.auth.scheme !== 'none',
    keyLabel: d.auth.label,
    keyRequired: d.auth.required,
    keyPlaceholder: d.auth.placeholder,
    keyTestId: isCli ? 'provider-oauth-token-input' : 'provider-api-key-input',
    showBaseUrl: d.baseUrl !== 'hidden',
    baseUrlRequired: d.baseUrl === 'required',
    baseUrlPlaceholder: d.defaultBaseUrl ?? '',
    isCli,
    modelRequired: d.defaultModel === undefined,
  };
}

export function providerTypeOptions(): { value: AiProviderType; label: string }[] {
  return AI_PROVIDER_CATALOG.map((p) => ({ value: p.id, label: p.label }));
}

/** True when the row should show a "No Key" badge: the key is required and none is saved. */
export function providerNeedsKeyBadge(type: string, hasApiKey: boolean): boolean {
  const d = getProviderDescriptor(type);
  return !!d && d.auth.required && !hasApiKey;
}

export function validateProviderForm(typeId: string, baseUrl: string): { ok: true } | { ok: false; error: string } {
  const d = getProviderDescriptor(typeId);
  if (!d) return { ok: true };
  if (d.baseUrl === 'required' && baseUrl.trim() === '') return { ok: false, error: 'Base URL is required for this provider' };
  const r = normalizeBaseUrl(d, baseUrl);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
