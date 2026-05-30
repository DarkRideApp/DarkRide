import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { Modal } from '@darkrideapp/plugin-sdk/react';
import { ConfirmDialog } from '@darkrideapp/plugin-sdk/react';
import { AiRateLimitsPanel } from '../AiRateLimitsPanel';
import {
  SectionCard, SectionHeading,
  ProviderTypeBadge, ProviderStatusBadge, ModelStatusBadge,
  PROVIDER_TYPE_OPTIONS,
} from './SettingsShared';
import type { AiModelConfig } from '../../../shared/types/ai-models';
import type { AiProviderConfig, AiProviderType } from '../../../shared/types/ai-providers';
import type { AiTier } from '@darkrideapp/plugin-sdk/react';

export function AISection() {
  const ws = useWebSocket();
  const toast = useToast();

  // AI Providers
  const [aiProvidersList, setAiProvidersList] = useState<AiProviderConfig[]>([]);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AiProviderConfig | null>(null);
  const [providerForm, setProviderForm] = useState({
    name: '', type: 'gemini' as AiProviderType, apiKey: '', baseUrl: '', clearApiKey: false,
  });
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerTestResult, setProviderTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [providerTesting, setProviderTesting] = useState(false);

  // AI Tiers
  const [tiers, setTiers] = useState<AiTier[]>([]);
  const [tierForm, setTierForm] = useState<{ open: boolean; name: string; editingId: number | null }>({ open: false, name: '', editingId: null });

  // AI Models
  const [aiModelsList, setAiModelsList] = useState<AiModelConfig[]>([]);
  const [showModelModal, setShowModelModal] = useState(false);
  const [editingModel, setEditingModel] = useState<AiModelConfig | null>(null);
  const [modelForm, setModelForm] = useState({
    name: '', providerId: 0, model: '', cooldownMinutes: 10, tierId: null as number | null,
  });
  const [modelSaving, setModelSaving] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [modelTesting, setModelTesting] = useState(false);
  const [providerModels, setProviderModels] = useState<{ id: string; name: string }[]>([]);
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [deleteProviderConfirm, setDeleteProviderConfirm] = useState<AiProviderConfig | null>(null);
  const [deleteModelConfirm, setDeleteModelConfirm] = useState<AiModelConfig | null>(null);

  // Claude CLI status
  const [claudeCliAvailable, setClaudeCliAvailable] = useState<boolean | null>(null);
  const [claudeCliVersion, setClaudeCliVersion] = useState<string | null>(null);

  const fetchClaudeCliStatus = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/ai/claude-cli/status');
      if (res.body?.success) {
        setClaudeCliAvailable(res.body.data?.available ?? false);
        setClaudeCliVersion(res.body.data?.version ?? null);
      }
    } catch { setClaudeCliAvailable(false); }
  }, [ws]);

  const fetchAiProviders = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/ai/providers');
      if (res.body?.success) setAiProvidersList(res.body.data || []);
    } catch {}
  }, [ws]);

  const fetchAiModels = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/ai/models');
      if (res.body?.success) setAiModelsList(res.body.data || []);
    } catch {}
  }, [ws]);

  const fetchAiTiers = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/ai/tiers');
      if (res.status !== 200) return;
      // Backend's GET /v1/ai/tiers returns a raw array. Be permissive about
      // an envelope shape ({success, data: [...]}) in case the deployed
      // backend trails the frontend by a few commits — the alternative is
      // a silently empty tier list, which is the regression the user hit.
      const body = res.body;
      if (Array.isArray(body)) setTiers(body as AiTier[]);
      else if (body && typeof body === 'object' && Array.isArray((body as any).data)) {
        setTiers((body as any).data as AiTier[]);
      }
    } catch {}
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      fetchAiProviders();
      fetchAiModels();
      fetchAiTiers();
      fetchClaudeCliStatus();
    }
  }, [ws.connected, fetchAiProviders, fetchAiModels, fetchAiTiers, fetchClaudeCliStatus]);

  // AI Provider handlers
  const handleOpenAddProvider = () => {
    setEditingProvider(null);
    setProviderForm({ name: '', type: 'gemini', apiKey: '', baseUrl: '', clearApiKey: false });
    setProviderTestResult(null);
    setShowProviderModal(true);
  };

  const handleOpenEditProvider = (p: AiProviderConfig) => {
    setEditingProvider(p);
    setProviderForm({
      name: p.name, type: p.type, apiKey: '', baseUrl: p.baseUrl || '', clearApiKey: false,
    });
    setProviderTestResult(null);
    setShowProviderModal(true);
  };

  const handleSaveProvider = async () => {
    setProviderSaving(true);
    try {
      const payload: Record<string, any> = {
        name: providerForm.name,
        type: providerForm.type,
        baseUrl: providerForm.baseUrl || null,
      };
      // Explicit empty string clears the stored key (backend: '' -> null).
      // Otherwise only send a key when the user typed a new one — an untouched
      // empty box must NOT wipe the existing secret.
      if (providerForm.clearApiKey) payload.apiKey = '';
      else if (providerForm.apiKey) payload.apiKey = providerForm.apiKey;

      if (editingProvider) {
        await ws.sendRestApi('PUT', `/v1/ai/providers/${editingProvider.id}`, payload);
      } else {
        await ws.sendRestApi('POST', '/v1/ai/providers', payload);
      }

      setShowProviderModal(false);
      fetchAiProviders();
      fetchAiModels();
      toast.success('AI provider saved');
    } catch {
      toast.error('Failed to save AI provider');
    } finally {
      setProviderSaving(false);
    }
  };

  // Shown under a secret field when editing a provider that already has one
  // saved, so the user can explicitly REMOVE it (the field itself always
  // renders empty — the secret is never sent back to the client).
  const renderSavedKeyNotice = () => {
    if (!editingProvider?.hasApiKey) return null;
    if (providerForm.clearApiKey) {
      return (
        <div style={{ fontSize: 12, color: 'var(--status-error, #ef4444)', display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          Saved key will be removed when you save.
          <button type="button" className="btn btn-sm" data-testid="provider-key-undo-remove"
            onClick={() => setProviderForm(f => ({ ...f, clearApiKey: false }))}>Undo</button>
        </div>
      );
    }
    return (
      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <span style={{ color: 'var(--status-online, #22c55e)' }}>✓ A key is saved</span>
        <button type="button" className="btn btn-sm" data-testid="provider-key-remove"
          onClick={() => setProviderForm(f => ({ ...f, apiKey: '', clearApiKey: true }))}>Remove</button>
      </div>
    );
  };

  const handleDeleteProvider = async (id: number) => {
    try {
      const res = await ws.sendRestApi('DELETE', `/v1/ai/providers/${id}`);
      if (!res.body?.success) {
        toast.error(res.body?.error || 'Failed to delete provider');
        return;
      }
      fetchAiProviders();
      toast.success('AI provider deleted');
    } catch {
      toast.error('Failed to delete provider');
    }
  };

  const handleTestProvider = async (id: number) => {
    setProviderTesting(true);
    setProviderTestResult(null);
    try {
      const res = await ws.sendRestApi('POST', `/v1/ai/providers/${id}/test`);
      setProviderTestResult(res.body?.success
        ? { success: true, message: `Connected to ${res.body.model}` }
        : { success: false, message: res.body?.error || 'Test failed' }
      );
    } catch (err: any) {
      setProviderTestResult({ success: false, message: err?.message || 'Test failed' });
    } finally {
      setProviderTesting(false);
    }
  };

  // AI Model handlers
  const fetchProviderModelList = async (providerId: number) => {
    if (!providerId) { setProviderModels([]); return; }
    setProviderModelsLoading(true);
    try {
      const res = await ws.sendRestApi('GET', `/v1/ai/providers/${providerId}/models`);
      setProviderModels(res.body?.data || []);
    } catch {
      setProviderModels([]);
    } finally {
      setProviderModelsLoading(false);
    }
  };

  const handleOpenAddModel = (prefillTierId?: number) => {
    setEditingModel(null);
    const pid = aiProvidersList[0]?.id || 0;
    const defaultTierId = prefillTierId ?? tiers.find(t => t.name === 'High')?.id ?? tiers[0]?.id ?? null;
    setModelForm({ name: '', providerId: pid, model: '', cooldownMinutes: 10, tierId: defaultTierId });
    setModelTestResult(null);
    setShowModelModal(true);
    fetchProviderModelList(pid);
  };

  const handleOpenEditModel = (m: AiModelConfig) => {
    setEditingModel(m);
    setModelForm({
      name: m.name, providerId: m.providerId || 0, model: m.model || '', cooldownMinutes: m.cooldownMinutes, tierId: m.tierId ?? null,
    });
    setModelTestResult(null);
    setShowModelModal(true);
    fetchProviderModelList(m.providerId || 0);
  };

  const handleSaveModel = async () => {
    setModelSaving(true);
    try {
      const payload: Record<string, any> = {
        name: modelForm.name,
        providerId: modelForm.providerId,
        model: modelForm.model || null,
        cooldownMinutes: modelForm.cooldownMinutes,
        tierId: modelForm.tierId,
      };

      if (editingModel) {
        await ws.sendRestApi('PUT', `/v1/ai/models/${editingModel.id}`, payload);
      } else {
        await ws.sendRestApi('POST', '/v1/ai/models', payload);
      }

      setShowModelModal(false);
      fetchAiModels();
      fetchAiTiers();
      toast.success('AI model saved');
    } catch {
      toast.error('Failed to save AI model');
    } finally {
      setModelSaving(false);
    }
  };

  const handleDuplicateModel = (m: AiModelConfig) => {
    setEditingModel(null);
    setModelForm({
      name: `${m.name} (copy)`, providerId: m.providerId || 0, model: m.model || '', cooldownMinutes: m.cooldownMinutes, tierId: m.tierId ?? null,
    });
    setModelTestResult(null);
    setShowModelModal(true);
    fetchProviderModelList(m.providerId || 0);
  };

  const handleDeleteModel = async (id: number) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/ai/models/${id}`);
      fetchAiModels();
      refreshTiers();
      toast.success('AI model deleted');
    } catch {
      toast.error('Failed to delete AI model');
    }
  };

  const handleToggleModel = async (id: number) => {
    try {
      await ws.sendRestApi('PUT', `/v1/ai/models/${id}/toggle`);
      fetchAiModels();
    } catch {
      toast.error('Failed to toggle AI model');
    }
  };

  const handleMoveModel = async (id: number, direction: 'up' | 'down', tierId: number | null) => {
    // Reorder within the same tier only
    const tierModels = aiModelsList.filter(m => m.tierId === tierId);
    const idx = tierModels.findIndex(m => m.id === id);
    if (idx < 0) return;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= tierModels.length) return;

    // Build a full reorder list: swap within tier, keep others in place
    const allIds = aiModelsList.map(m => m.id);
    const tierIds = tierModels.map(m => m.id);
    [tierIds[idx], tierIds[newIdx]] = [tierIds[newIdx], tierIds[idx]];

    // Splice updated tier order back into the full list
    let tierCursor = 0;
    const newIds = allIds.map(mid => {
      const tierIdx = tierModels.findIndex(m => m.id === mid);
      if (tierIdx >= 0) return tierIds[tierCursor++];
      return mid;
    });

    try {
      await ws.sendRestApi('PUT', '/v1/ai/models/reorder', { ids: newIds });
      fetchAiModels();
    } catch {
      toast.error('Failed to reorder AI models');
    }
  };

  const handleTestModel = async (id?: number) => {
    setModelTesting(true);
    setModelTestResult(null);
    try {
      if (id) {
        const res = await ws.sendRestApi('POST', `/v1/ai/models/${id}/test`);
        setModelTestResult(res.body?.success
          ? { success: true, message: `Connected to ${res.body.model}` }
          : { success: false, message: res.body?.error || 'Test failed' }
        );
      }
    } catch (err: any) {
      setModelTestResult({ success: false, message: err?.message || 'Test failed' });
    } finally {
      setModelTesting(false);
    }
  };

  // AI Tier helpers
  const refreshTiers = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/ai/tiers');
      if (res.status !== 200) return;
      // Same permissive parse as fetchAiTiers (above) — backend ships a raw
      // array, but accept an envelope too for tolerance against deploy drift.
      const body = res.body;
      if (Array.isArray(body)) setTiers(body as AiTier[]);
      else if (body && typeof body === 'object' && Array.isArray((body as any).data)) {
        setTiers((body as any).data as AiTier[]);
      }
    } catch {}
  }, [ws]);

  const createTier = async (name: string) => {
    const res = await ws.sendRestApi('POST', '/v1/ai/tiers', { name });
    if (res.status !== 201) {
      alert((res.body as any)?.error ?? 'Failed to create tier');
      return;
    }
    await refreshTiers();
  };

  const renameTier = async (id: number, name: string) => {
    const res = await ws.sendRestApi('PATCH', `/v1/ai/tiers/${id}`, { name });
    if (res.status !== 200) {
      alert((res.body as any)?.error ?? 'Failed to rename tier');
      return;
    }
    await refreshTiers();
  };

  const deleteTier = async (id: number) => {
    if (!confirm('Delete this tier?')) return;
    const res = await ws.sendRestApi('DELETE', `/v1/ai/tiers/${id}`);
    if (res.status === 409) {
      toast.error((res.body as any)?.error ?? 'Cannot delete tier — it is in use');
      return;
    }
    if (res.status !== 200 && res.status !== 204) {
      toast.error((res.body as any)?.error ?? 'Failed to delete tier');
      return;
    }
    await refreshTiers();
  };

  const moveTierUp = async (id: number) => {
    const idx = tiers.findIndex(t => t.id === id);
    if (idx <= 0) return;
    const ids = tiers.map(t => t.id);
    [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
    try {
      await ws.sendRestApi('PUT', '/v1/ai/tiers/reorder', { ids });
      await refreshTiers();
    } catch {
      toast.error('Failed to reorder tiers');
    }
  };

  const moveTierDown = async (id: number) => {
    const idx = tiers.findIndex(t => t.id === id);
    if (idx < 0 || idx >= tiers.length - 1) return;
    const ids = tiers.map(t => t.id);
    [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
    try {
      await ws.sendRestApi('PUT', '/v1/ai/tiers/reorder', { ids });
      await refreshTiers();
    } catch {
      toast.error('Failed to reorder tiers');
    }
  };

  const moveModelToTier = async (modelId: number, tierId: number) => {
    try {
      await ws.sendRestApi('POST', `/v1/ai/models/${modelId}/move-tier`, { tierId });
      fetchAiModels();
      refreshTiers();
    } catch {
      toast.error('Failed to move model to tier');
    }
  };

  return (
    <div id="section-ai">
      <SectionHeading>AI</SectionHeading>

      {/* ── AI Providers ── */}
      <SectionCard
        id="ai-providers"
        title="AI Providers"
        description="Configure API credentials for AI providers. Multiple models can share a single provider."
        status={aiProvidersList.length > 0 || claudeCliAvailable ? 'configured' : 'not-configured'}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Claude CLI status */}
          {claudeCliAvailable !== null && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', borderRadius: 6,
              background: claudeCliAvailable ? 'rgba(34,197,94,0.06)' : 'rgba(128,128,128,0.06)',
              border: `1px solid ${claudeCliAvailable ? 'rgba(34,197,94,0.2)' : 'var(--border-color)'}`,
              marginBottom: 4,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: claudeCliAvailable ? 'var(--status-online, #22c55e)' : 'var(--text-muted)',
                flexShrink: 0,
              }} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>Claude CLI</span>
              {claudeCliVersion && (
                <span style={{
                  fontSize: 12, fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--text-muted)', padding: '1px 6px', borderRadius: 4,
                  background: 'rgba(128,128,128,0.12)',
                }}>
                  v{claudeCliVersion}
                </span>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {claudeCliAvailable
                  ? 'Detected — keep it updated so newer models can use tools (an outdated CLI silently skips tool calls)'
                  : 'Not found — install claude CLI to enable'}
              </span>
              {claudeCliAvailable && (
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
                  data-testid="reauth-claude-btn"
                  title="Opens the in-browser Terminal and runs `claude login` as the server user — no SSH needed"
                  onClick={() => window.dispatchEvent(new CustomEvent('terminal:open-host', {
                    detail: { label: 'Claude login', initialCommand: 'claude login' },
                  }))}
                >
                  Re-authenticate
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={handleOpenAddProvider}
              data-testid="add-ai-provider-btn"
            >
              Add Provider
            </button>
            {aiProvidersList.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {aiProvidersList.length} provider{aiProvidersList.length !== 1 ? 's' : ''} configured
              </span>
            )}
          </div>

          {aiProvidersList.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
              No AI providers configured. Add a provider to start using AI features.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {aiProvidersList.map(p => (
                <div
                  key={p.id}
                  data-testid={`ai-provider-row-${p.id}`}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '8px 10px', borderRadius: 6,
                    background: 'var(--bg-secondary)',
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</span>
                    <ProviderTypeBadge type={p.type} />
                    <ProviderStatusBadge provider={p} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => handleOpenEditProvider(p)}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setDeleteProviderConfirm(p)}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── AI Models (grouped by tier) ── */}
      <SectionCard
        id="ai-models"
        title="AI Models"
        description="Models are grouped by tier. On rate limit (429), the next model in the same tier is tried; then the next tier is used."
        status={aiModelsList.length > 0 ? 'configured' : 'not-configured'}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => handleOpenAddModel()}
              disabled={aiProvidersList.length === 0}
              data-testid="add-ai-model-btn"
              title={aiProvidersList.length === 0 ? 'Add a provider first' : undefined}
            >
              Add Model
            </button>
            {aiModelsList.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {aiModelsList.length} model{aiModelsList.length !== 1 ? 's' : ''} configured
              </span>
            )}
          </div>

          {tiers.map(tier => {
            const tierModels = aiModelsList.filter(m => m.tierId === tier.id);
            const enabledCount = tierModels.filter(m => m.enabled).length;
            const tierIdx = tiers.findIndex(t => t.id === tier.id);
            return (
              <div
                key={tier.id}
                data-testid={`ai-tier-card-${tier.id}`}
                style={{ border: '1px solid var(--border-color)', borderRadius: 6, marginBottom: 4 }}
              >
                {/* Tier header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px',
                  background: 'var(--bg-secondary)',
                  borderBottom: tierModels.length > 0 ? '1px solid var(--border-color)' : undefined,
                  borderRadius: tierModels.length > 0 ? '6px 6px 0 0' : 6,
                  flexWrap: 'wrap',
                }}>
                  <strong style={{ color: 'var(--text-primary)', fontSize: 13 }}>{tier.name}</strong>
                  {tier.isHardcoded && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(built-in)</span>
                  )}
                  {!tier.isHardcoded && (
                    <button
                      className="btn btn-sm"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setTierForm({ open: true, name: tier.name, editingId: tier.id })}
                      data-testid={`rename-tier-${tier.id}`}
                    >
                      Rename
                    </button>
                  )}
                  <button
                    className="btn btn-sm"
                    style={{ padding: '2px 6px', fontSize: 11, opacity: tierIdx === 0 ? 0.3 : 1 }}
                    onClick={() => moveTierUp(tier.id)}
                    disabled={tierIdx === 0}
                    title="Move tier up"
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ padding: '2px 6px', fontSize: 11, opacity: tierIdx === tiers.length - 1 ? 0.3 : 1 }}
                    onClick={() => moveTierDown(tier.id)}
                    disabled={tierIdx === tiers.length - 1}
                    title="Move tier down"
                  >
                    ↓
                  </button>
                  {!tier.isHardcoded && (
                    <button
                      className="btn btn-sm btn-danger"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => deleteTier(tier.id)}
                      data-testid={`delete-tier-${tier.id}`}
                    >
                      Delete
                    </button>
                  )}
                  {enabledCount === 0 && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--warning, #f59e0b)' }}>
                      empty — requests fall back
                    </span>
                  )}
                </div>

                {/* Tier body */}
                <div style={{ padding: 8 }}>
                  {tierModels.length === 0 && (
                    <div style={{ padding: '4px 2px', color: 'var(--text-muted)', fontSize: 12 }}>
                      No models in this tier.
                    </div>
                  )}
                  {tierModels.map((m, idx) => (
                    <div
                      key={m.id}
                      data-testid={`ai-model-row-${m.id}`}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '6px 8px', borderRadius: 4, marginBottom: 2,
                        background: 'var(--bg-tertiary, var(--bg-secondary))',
                        fontSize: 13,
                        opacity: m.enabled ? 1 : 0.5,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 18, textAlign: 'center',
                          fontSize: 11, fontWeight: 600, color: 'var(--text-muted)',
                        }}>
                          {idx + 1}
                        </span>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <span style={{ fontWeight: 500, fontSize: 13 }}>{m.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {m.providerName || m.provider}{m.model ? ` / ${m.model}` : ''}
                          </span>
                        </div>
                        <ModelStatusBadge model={m} />
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleMoveModel(m.id, 'up', tier.id)}
                          disabled={idx === 0}
                          style={{ padding: '2px 6px', fontSize: 11, opacity: idx === 0 ? 0.3 : 1 }}
                          title="Move up in tier"
                        >
                          ↑
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleMoveModel(m.id, 'down', tier.id)}
                          disabled={idx === tierModels.length - 1}
                          style={{ padding: '2px 6px', fontSize: 11, opacity: idx === tierModels.length - 1 ? 0.3 : 1 }}
                          title="Move down in tier"
                        >
                          ↓
                        </button>
                        <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', marginLeft: 2 }}>
                          <input
                            type="checkbox"
                            checked={m.enabled}
                            onChange={() => handleToggleModel(m.id)}
                            style={{ marginRight: 3 }}
                          />
                          <span style={{ fontSize: 11 }}>On</span>
                        </label>
                        {tiers.length > 1 && (
                          <select
                            className="form-input"
                            value={m.tierId ?? ''}
                            onChange={e => moveModelToTier(m.id, parseInt(e.target.value))}
                            style={{ fontSize: 11, padding: '1px 4px', height: 24 }}
                            title="Move to tier"
                            data-testid={`model-tier-select-${m.id}`}
                          >
                            {tiers.map(t => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        )}
                        <button
                          className="btn btn-sm"
                          onClick={() => handleOpenEditModel(m)}
                          style={{ padding: '2px 8px', fontSize: 11 }}
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleDuplicateModel(m)}
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          title="Duplicate model"
                        >
                          Duplicate
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setDeleteModelConfirm(m)}
                          style={{ padding: '2px 8px', fontSize: 11 }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    className="btn btn-sm btn-primary"
                    style={{ marginTop: 6 }}
                    onClick={() => handleOpenAddModel(tier.id)}
                    disabled={aiProvidersList.length === 0}
                    title={aiProvidersList.length === 0 ? 'Add a provider first' : undefined}
                    data-testid={`add-model-to-tier-${tier.id}`}
                  >
                    + Add model to {tier.name}
                  </button>
                </div>
              </div>
            );
          })}

          {tiers.length === 0 && aiModelsList.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 0' }}>
              No tiers or models configured. Add a tier to get started.
            </div>
          )}

          <button
            className="btn btn-sm"
            style={{ marginTop: 4, alignSelf: 'flex-start' }}
            onClick={() => setTierForm({ open: true, name: '', editingId: null })}
            data-testid="add-tier-btn"
          >
            + Add tier
          </button>

          <AiRateLimitsPanel />
        </div>
      </SectionCard>

      {/* ── Provider Modal ── */}
      {showProviderModal && (
        <Modal
          title={editingProvider ? 'Edit AI Provider' : 'Add AI Provider'}
          onClose={() => setShowProviderModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowProviderModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleSaveProvider}
                disabled={providerSaving || !providerForm.name || !providerForm.type}
                data-testid="save-provider-btn"
              >
                {providerSaving ? 'Saving...' : editingProvider ? 'Update' : 'Add'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-group">
              <label htmlFor="settings-llm-name">Name</label>
              <input
                id="settings-llm-name"
                className="form-input"
                value={providerForm.name}
                onChange={e => setProviderForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Anthropic (Work)"
                data-testid="provider-name-input"
              />
            </div>

            <div className="form-group">
              <label htmlFor="settings-llm-type">Type</label>
              <select
                id="settings-llm-type"
                className="form-input"
                value={providerForm.type}
                onChange={e => setProviderForm(f => ({ ...f, type: e.target.value as AiProviderType }))}
                data-testid="provider-type-select"
              >
                {PROVIDER_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {providerForm.type === 'claude-cli' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>
                  Uses the server's Claude CLI login. To (re)authenticate without SSH, open the
                  in-browser <strong>Terminal</strong> (logs panel) — it runs as the same user as the
                  server — and run <code style={{ fontSize: 12 }}>claude login</code> or{' '}
                  <code style={{ fontSize: 12 }}>claude setup-token</code>. Leave the token below
                  empty to use that login, or paste a <code style={{ fontSize: 12 }}>setup-token</code>{' '}
                  to override it. A wrong/stale token authenticates but can't run tools.
                </div>
                <div className="form-group">
                  <label htmlFor="settings-llm-oauth-token">
                    OAuth Token <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(optional)</span>
                  </label>
                  <input
                    id="settings-llm-oauth-token"
                    className="form-input"
                    type="password"
                    value={providerForm.apiKey}
                    onChange={e => setProviderForm(f => ({ ...f, apiKey: e.target.value, clearApiKey: false }))}
                    placeholder={editingProvider?.hasApiKey ? 'Enter new token to replace' : 'CLAUDE_CODE_OAUTH_TOKEN from setup-token'}
                    data-testid="provider-oauth-token-input"
                  />
                  {renderSavedKeyNotice()}
                </div>
              </div>
            )}

            {['anthropic', 'gemini', 'openrouter', 'codestral'].includes(providerForm.type) && (
              <div className="form-group">
                <label htmlFor="settings-llm-api-key">API Key</label>
                <input
                  id="settings-llm-api-key"
                  className="form-input"
                  type="password"
                  value={providerForm.apiKey}
                  onChange={e => setProviderForm(f => ({ ...f, apiKey: e.target.value, clearApiKey: false }))}
                  placeholder={editingProvider?.hasApiKey ? 'Enter new key to replace' : 'Enter API key'}
                  data-testid="provider-api-key-input"
                />
                {renderSavedKeyNotice()}
              </div>
            )}

            {providerForm.type === 'ollama' && (
              <div className="form-group">
                <label htmlFor="settings-llm-base-url">Base URL</label>
                <input
                  id="settings-llm-base-url"
                  className="form-input"
                  value={providerForm.baseUrl}
                  onChange={e => setProviderForm(f => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="http://localhost:11434"
                  data-testid="provider-base-url-input"
                />
              </div>
            )}

            {editingProvider && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  className="btn"
                  onClick={() => handleTestProvider(editingProvider.id)}
                  disabled={providerTesting}
                  data-testid="test-provider-btn"
                >
                  {providerTesting ? 'Testing...' : 'Test Connection'}
                </button>
                {providerTestResult && (
                  <span style={{
                    fontSize: 12,
                    color: providerTestResult.success ? 'var(--status-online, #22c55e)' : 'var(--status-error, #ef4444)',
                    fontWeight: 500,
                  }}>
                    {providerTestResult.message}
                  </span>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Model Modal ── */}
      {showModelModal && (
        <Modal
          title={editingModel ? 'Edit AI Model' : 'Add AI Model'}
          onClose={() => setShowModelModal(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowModelModal(false)}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleSaveModel}
                disabled={modelSaving || !modelForm.name || !modelForm.providerId}
                data-testid="save-model-btn"
              >
                {modelSaving ? 'Saving...' : editingModel ? 'Update' : 'Add'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-group">
              <label>Name</label>
              <input
                className="form-input"
                value={modelForm.name}
                onChange={e => setModelForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Claude Sonnet (Primary)"
                data-testid="model-name-input"
              />
            </div>

            <div className="form-group">
              <label>Provider</label>
              <select
                className="form-input"
                value={modelForm.providerId}
                onChange={e => {
                  const pid = parseInt(e.target.value);
                  setModelForm(f => ({ ...f, providerId: pid, model: '' }));
                  fetchProviderModelList(pid);
                }}
                data-testid="model-provider-select"
              >
                <option value={0} disabled>Select a provider...</option>
                {aiProvidersList.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({PROVIDER_TYPE_OPTIONS.find(o => o.value === p.type)?.label || p.type})</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>
                Model <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(optional, uses provider default)</span>
                {providerModelsLoading && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>Loading models...</span>}
              </label>
              {providerModels.length > 0 ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <select
                    className="form-input"
                    value={providerModels.some(m => m.id === modelForm.model) ? modelForm.model : '__custom__'}
                    onChange={e => {
                      if (e.target.value !== '__custom__') {
                        setModelForm(f => ({ ...f, model: e.target.value }));
                      }
                    }}
                    style={{ flex: 1 }}
                    data-testid="model-model-select"
                  >
                    <option value="">— Provider default —</option>
                    {providerModels.map(m => (
                      <option key={m.id} value={m.id}>{m.name !== m.id ? `${m.name} (${m.id})` : m.id}</option>
                    ))}
                    {modelForm.model && !providerModels.some(m => m.id === modelForm.model) && (
                      <option value="__custom__">Custom: {modelForm.model}</option>
                    )}
                  </select>
                  <input
                    className="form-input"
                    value={modelForm.model}
                    onChange={e => setModelForm(f => ({ ...f, model: e.target.value }))}
                    placeholder="or type custom model ID"
                    style={{ flex: 1 }}
                    data-testid="model-model-input"
                  />
                </div>
              ) : (
                <input
                  className="form-input"
                  value={modelForm.model}
                  onChange={e => setModelForm(f => ({ ...f, model: e.target.value }))}
                  placeholder="e.g. claude-sonnet-4-20250514"
                  data-testid="model-model-input"
                />
              )}
            </div>

            <div className="form-group">
              <label>Cooldown Minutes <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(after rate limit)</span></label>
              <input
                className="form-input"
                type="number"
                value={modelForm.cooldownMinutes}
                onChange={e => setModelForm(f => ({ ...f, cooldownMinutes: parseInt(e.target.value) || 10 }))}
                min={1}
                max={60}
                data-testid="model-cooldown-input"
              />
            </div>

            <div className="form-group">
              <label>Tier</label>
              <select
                className="form-input"
                value={modelForm.tierId ?? ''}
                onChange={e => setModelForm(f => ({ ...f, tierId: e.target.value ? parseInt(e.target.value) : null }))}
                data-testid="model-tier-select"
              >
                <option value="">— No tier —</option>
                {tiers.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>

            {editingModel && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  className="btn"
                  onClick={() => handleTestModel(editingModel.id)}
                  disabled={modelTesting}
                  data-testid="test-model-btn"
                >
                  {modelTesting ? 'Testing...' : 'Test Connection'}
                </button>
                {modelTestResult && (
                  <span style={{
                    fontSize: 12,
                    color: modelTestResult.success ? 'var(--status-online, #22c55e)' : 'var(--status-error, #ef4444)',
                    fontWeight: 500,
                  }}>
                    {modelTestResult.message}
                  </span>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {deleteProviderConfirm && (
        <ConfirmDialog
          title="Delete AI Provider"
          message={`Are you sure you want to delete the provider "${deleteProviderConfirm.name}"? Any models using this provider will stop working.`}
          onConfirm={() => { handleDeleteProvider(deleteProviderConfirm.id); setDeleteProviderConfirm(null); }}
          onCancel={() => setDeleteProviderConfirm(null)}
        />
      )}

      {deleteModelConfirm && (
        <ConfirmDialog
          title="Delete AI Model"
          message={`Are you sure you want to delete the model "${deleteModelConfirm.name}"? This action cannot be undone.`}
          onConfirm={() => { handleDeleteModel(deleteModelConfirm.id); setDeleteModelConfirm(null); }}
          onCancel={() => setDeleteModelConfirm(null)}
        />
      )}

      {/* ── Tier Form Modal ── */}
      {tierForm.open && (
        <Modal
          title={tierForm.editingId ? 'Rename Tier' : 'Add Tier'}
          onClose={() => setTierForm({ open: false, name: '', editingId: null })}
          footer={
            <>
              <button className="btn" onClick={() => setTierForm({ open: false, name: '', editingId: null })}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!tierForm.name.trim()}
                onClick={async () => {
                  if (tierForm.editingId) {
                    await renameTier(tierForm.editingId, tierForm.name.trim());
                  } else {
                    await createTier(tierForm.name.trim());
                  }
                  setTierForm({ open: false, name: '', editingId: null });
                }}
                data-testid="save-tier-btn"
              >
                {tierForm.editingId ? 'Rename' : 'Add'}
              </button>
            </>
          }
        >
          <div className="form-group">
            <label>Tier Name</label>
            <input
              className="form-input"
              value={tierForm.name}
              onChange={e => setTierForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Premium"
              autoFocus
              data-testid="tier-name-input"
              onKeyDown={e => {
                if (e.key === 'Enter' && tierForm.name.trim()) {
                  (e.currentTarget.closest('[data-testid="save-tier-btn"]') as HTMLButtonElement | null)?.click();
                }
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
