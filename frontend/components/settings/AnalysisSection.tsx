import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import { TierPicker, useAiTiers } from '@darkrideapp/plugin-sdk/react';
import { SectionCard, SectionHeading, FieldRow, Field, SaveButton } from './SettingsShared';
import type { Setting } from '../../../shared/types/api';

export function AnalysisSection() {
  const ws = useWebSocket();
  const toast = useToast();
  const { tiers } = useAiTiers();

  const [excludedPaths, setExcludedPaths] = useState('');
  const [excludedSaving, setExcludedSaving] = useState(false);
  const [excludedSaved, setExcludedSaved] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiPromptSaving, setAiPromptSaving] = useState(false);
  const [aiPromptSaved, setAiPromptSaved] = useState(false);
  const [diffPrompt, setDiffPrompt] = useState('');
  const [diffPromptSaving, setDiffPromptSaving] = useState(false);
  const [diffPromptSaved, setDiffPromptSaved] = useState(false);
  const [analysisAutorun, setAnalysisAutorun] = useState(true);
  const [diffAutorun, setDiffAutorun] = useState(true);
  // Tier NAMES, not model IDs. Backend reads these settings via getTierConfig()
  // in backend/index.ts and routes through aiModelRouter.getModelsForTier(name).
  // Defaults match the backend defaults (Low / High).
  const [tierResearch, setTierResearch] = useState('Low');
  const [tierWrite, setTierWrite] = useState('High');
  const [tierSaving, setTierSaving] = useState(false);
  const [tierSaved, setTierSaved] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/settings/list');
      const data: Setting[] = res.body?.data || [];
      const map = new Map(data.map((s) => [s.key, s.value]));

      const excludedRaw = map.get('analysis_excluded_paths');
      if (excludedRaw) {
        try {
          const parsed = JSON.parse(excludedRaw);
          if (Array.isArray(parsed)) setExcludedPaths(parsed.join('\n'));
        } catch { /* ignore */ }
      }
      setAiPrompt(map.get('analysis_ai_prompt') || '');
      setAnalysisAutorun(map.get('analysis_ai_autorun') !== 'false');
      setDiffPrompt(map.get('diff_ai_prompt') || '');
      setDiffAutorun(map.get('diff_ai_autorun') !== 'false');
      // analysis_tier_research / analysis_tier_write hold the tier NAME (e.g.
      // "Low" / "High"). Defaults match backend's getTierConfig() defaults.
      if (map.has('analysis_tier_research')) setTierResearch(map.get('analysis_tier_research')!);
      if (map.has('analysis_tier_write')) setTierWrite(map.get('analysis_tier_write')!);
    } catch {}
  }, [ws]);

  useEffect(() => {
    if (ws.connected) fetchSettings();
  }, [ws.connected, fetchSettings]);

  const handleSaveExcludedPaths = async () => {
    setExcludedSaving(true);
    setExcludedSaved(false);
    try {
      const lines = excludedPaths.split('\n').map(l => l.trim()).filter(Boolean);
      await ws.sendRestApi('PUT', '/v1/settings/analysis_excluded_paths', {
        value: JSON.stringify(lines),
      });
      setExcludedSaved(true);
      setTimeout(() => setExcludedSaved(false), 3000);
      toast.success('Excluded paths saved');
    } catch {
      toast.error('Failed to save excluded paths');
    } finally {
      setExcludedSaving(false);
    }
  };

  const handleSaveAiPrompt = async () => {
    setAiPromptSaving(true);
    setAiPromptSaved(false);
    try {
      if (aiPrompt.trim() === '') {
        await ws.sendRestApi('DELETE', '/v1/settings/analysis_ai_prompt');
      } else {
        await ws.sendRestApi('PUT', '/v1/settings/analysis_ai_prompt', { value: aiPrompt });
      }
      setAiPromptSaved(true);
      setTimeout(() => setAiPromptSaved(false), 2000);
      toast.success('AI prompt saved');
    } catch {
      toast.error('Failed to save AI prompt');
    } finally {
      setAiPromptSaving(false);
    }
  };

  const handleResetAiPrompt = async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/settings/defaults/analysis_ai_prompt');
      if (res?.body?.data?.value) setAiPrompt(res.body.data.value);
    } catch {}
  };

  const handleSaveDiffPrompt = async () => {
    setDiffPromptSaving(true);
    setDiffPromptSaved(false);
    try {
      if (diffPrompt.trim() === '') {
        await ws.sendRestApi('DELETE', '/v1/settings/diff_ai_prompt');
      } else {
        await ws.sendRestApi('PUT', '/v1/settings/diff_ai_prompt', { value: diffPrompt });
      }
      setDiffPromptSaved(true);
      setTimeout(() => setDiffPromptSaved(false), 2000);
      toast.success('Diff prompt saved');
    } catch {
      toast.error('Failed to save diff prompt');
    } finally {
      setDiffPromptSaving(false);
    }
  };

  const handleResetDiffPrompt = async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/settings/defaults/diff_ai_prompt');
      if (res?.body?.data?.value) setDiffPrompt(res.body.data.value);
    } catch {}
  };

  const handleToggleAnalysisAutorun = async (checked: boolean) => {
    setAnalysisAutorun(checked);
    try {
      await ws.sendRestApi('PUT', '/v1/settings/analysis_ai_autorun', { value: checked ? 'true' : 'false' });
    } catch { /* ignore */ }
  };

  const handleToggleDiffAutorun = async (checked: boolean) => {
    setDiffAutorun(checked);
    try {
      await ws.sendRestApi('PUT', '/v1/settings/diff_ai_autorun', { value: checked ? 'true' : 'false' });
    } catch { /* ignore */ }
  };

  const handleSaveTierConfig = async () => {
    setTierSaving(true);
    try {
      await ws.sendRestApi('PUT', '/v1/settings/analysis_tier_research', { value: tierResearch });
      await ws.sendRestApi('PUT', '/v1/settings/analysis_tier_write', { value: tierWrite });
      setTierSaved(true);
      setTimeout(() => setTierSaved(false), 2000);
      toast.success('Tier configuration saved');
    } catch {
      toast.error('Failed to save tier configuration');
    } finally {
      setTierSaving(false);
    }
  };

  return (
    <div id="section-analysis">
      <SectionHeading>APK Analysis</SectionHeading>

      <SectionCard
        id="excluded-paths"
        title="APK Library Exclusions"
        description="Package prefixes to exclude from findings and strings. One per line, dot-notation (e.g. com.amazonaws)."
      >
        <textarea
          className="form-input"
          value={excludedPaths}
          onChange={e => setExcludedPaths(e.target.value)}
          placeholder={'com.alibaba\ncom.amazonaws\norg.apache\ncom.google.android.gms\ncom.squareup\nio.reactivex'}
          data-testid="excluded-paths-input"
          rows={6}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical', marginBottom: 12 }}
        />
        <SaveButton saving={excludedSaving} saved={excludedSaved} onClick={handleSaveExcludedPaths} testId="save-excluded-paths-btn" />
      </SectionCard>

      <SectionCard
        id="ai-autorun"
        title="AI Auto-Run"
        description="Control whether AI agents run automatically after analysis and diff operations."
      >
        <label data-testid="analysis-autorun-toggle" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 12, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={analysisAutorun}
            onChange={e => handleToggleAnalysisAutorun(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          <span>Auto-run AI review after APK analysis</span>
        </label>
        <label data-testid="diff-autorun-toggle" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={diffAutorun}
            onChange={e => handleToggleDiffAutorun(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          <span>Auto-run AI summary after diff analysis</span>
        </label>
      </SectionCard>

      <SectionCard
        id="ai-tier"
        title="AI Model Tiering"
        description="Pick which AI tier handles each phase of APK analysis. Research (cheaper) runs tool calls — reading files, gathering data. Write (more capable) generates the actual review or summary. Tiers are configured in Settings → AI; the router falls back to the next model in the tier on rate-limit."
      >
        <FieldRow style={{ marginBottom: 12 }}>
          <Field label="Research tier" width={260}>
            <TierPicker
              tiers={tiers}
              value={tierResearch}
              onChange={setTierResearch}
            />
          </Field>
          <Field label="Write tier" width={260}>
            <TierPicker
              tiers={tiers}
              value={tierWrite}
              onChange={setTierWrite}
            />
          </Field>
        </FieldRow>
        <SaveButton saving={tierSaving} saved={tierSaved} onClick={handleSaveTierConfig} testId="save-tier-config-btn" />
      </SectionCard>

      <SectionCard
        id="ai-review-prompt"
        title="AI Review Prompt"
        description="Prompt sent to the AI agent after APK analysis completes. Leave empty to use the default prompt."
      >
        <textarea
          className="form-input"
          value={aiPrompt}
          onChange={e => setAiPrompt(e.target.value)}
          placeholder="Leave empty to use the default theme park analysis prompt..."
          data-testid="ai-prompt-input"
          rows={10}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical', marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <SaveButton saving={aiPromptSaving} saved={aiPromptSaved} onClick={handleSaveAiPrompt} testId="save-ai-prompt-btn" />
          <button
            className="btn"
            onClick={handleResetAiPrompt}
            data-testid="reset-ai-prompt-btn"
          >
            Reset to Default
          </button>
        </div>
      </SectionCard>

      <SectionCard
        id="diff-ai-prompt"
        title="Diff Analysis Prompt"
        description="Prompt sent to the AI agent when generating a diff analysis between two APK versions. Leave empty to use the default prompt."
      >
        <textarea
          className="form-input"
          value={diffPrompt}
          onChange={e => setDiffPrompt(e.target.value)}
          placeholder="Leave empty to use the default diff analysis prompt..."
          data-testid="diff-prompt-input"
          rows={8}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical', marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <SaveButton saving={diffPromptSaving} saved={diffPromptSaved} onClick={handleSaveDiffPrompt} testId="save-diff-prompt-btn" />
          <button
            className="btn"
            onClick={handleResetDiffPrompt}
            data-testid="reset-diff-prompt-btn"
          >
            Reset to Default
          </button>
        </div>
      </SectionCard>

    </div>
  );
}
