import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import {
  SectionCard, SectionHeading, FieldRow, Field, SaveButton,
} from './SettingsShared';
import { KeyValueEditor, pairsToObject, objectToPairs, type KeyValuePair } from '@darkrideapp/plugin-sdk/react';
import type { Setting } from '../../../shared/types/api';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';

export function IntegrationsSection() {
  const ws = useWebSocket();
  const toast = useToast();
  const auth = useAuthOptional();
  const hasScope = auth?.hasScope ?? (() => true);

  // Google Play
  const [googlePlayEmail, setGooglePlayEmail] = useState('');
  const [googlePlayAasToken, setGooglePlayAasToken] = useState('');
  const [googlePlayConfigured, setGooglePlayConfigured] = useState(false);
  const [googlePlaySaving, setGooglePlaySaving] = useState(false);
  const [googlePlaySaved, setGooglePlaySaved] = useState(false);

  // Document Store
  const [docStoreUrl, setDocStoreUrl] = useState('');
  const [docStoreHeaders, setDocStoreHeaders] = useState<KeyValuePair[]>([]);
  const [docStoreConfigured, setDocStoreConfigured] = useState(false);
  const [docStoreSaving, setDocStoreSaving] = useState(false);
  const [docStoreSaved, setDocStoreSaved] = useState(false);

  // Frida
  const [fridaReleases, setFridaReleases] = useState<any[]>([]);
  const [fridaDefaultVersion, setFridaDefaultVersion] = useState('latest');
  const [fridaLastSync, setFridaLastSync] = useState<string>('');
  const [fridaSyncing, setFridaSyncing] = useState(false);
  const [fridaDownloading, setFridaDownloading] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/settings/list');
      const data: Setting[] = res.body?.data || [];
      const map = new Map(data.map((s) => [s.key, s.value]));

      setDocStoreConfigured(map.has('document_store_url'));
      setDocStoreUrl(map.get('document_store_url') || '');
      const rawHeaders = map.get('document_store_headers');
      if (rawHeaders) {
        try {
          const parsed = JSON.parse(rawHeaders);
          setDocStoreHeaders(objectToPairs(parsed && typeof parsed === 'object' ? parsed : {}));
        } catch {
          setDocStoreHeaders([]);
        }
      } else {
        setDocStoreHeaders([]);
      }
      setFridaDefaultVersion(map.get('frida_default_version') || 'latest');
      setFridaLastSync(map.get('frida_last_sync') || '');
      setGooglePlayConfigured(map.has('google_play_email') && map.has('google_play_aas_token'));
      if (map.has('google_play_email')) setGooglePlayEmail(map.get('google_play_email')!);
      if (map.has('google_play_aas_token')) setGooglePlayAasToken('');
    } catch {}
  }, [ws]);

  const fetchFridaReleases = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/frida/releases');
      setFridaReleases(res.body?.data || []);
    } catch {}
  }, [ws]);

  useEffect(() => {
    if (ws.connected) {
      if (hasScope('core.settings:read')) fetchSettings();
      if (hasScope('core.frida:read')) fetchFridaReleases();
    }
  }, [ws.connected, fetchSettings, fetchFridaReleases]);

  // Integration save handlers
  const handleSaveGooglePlay = async () => {
    setGooglePlaySaving(true);
    setGooglePlaySaved(false);
    try {
      if (googlePlayEmail) {
        await ws.sendRestApi('PUT', '/v1/settings/google_play_email', { value: googlePlayEmail });
      }
      if (googlePlayAasToken) {
        await ws.sendRestApi('PUT', '/v1/settings/google_play_aas_token', { value: googlePlayAasToken });
      }
      setGooglePlaySaved(true);
      setGooglePlayAasToken('');
      setGooglePlayConfigured(true);
      setTimeout(() => setGooglePlaySaved(false), 3000);
      toast.success('Google Play settings saved');
    } catch {
      toast.error('Failed to save Google Play settings');
    } finally {
      setGooglePlaySaving(false);
    }
  };

  const handleSaveDocStore = async () => {
    setDocStoreSaving(true);
    setDocStoreSaved(false);
    try {
      await ws.sendRestApi('PUT', '/v1/settings/document_store_url', { value: docStoreUrl });
      const headersObj = pairsToObject(docStoreHeaders);
      if (Object.keys(headersObj).length > 0) {
        await ws.sendRestApi('PUT', '/v1/settings/document_store_headers', { value: JSON.stringify(headersObj) });
      } else {
        await ws.sendRestApi('DELETE', '/v1/settings/document_store_headers');
      }
      setDocStoreSaved(true);
      setTimeout(() => setDocStoreSaved(false), 3000);
      toast.success('Document store settings saved');
    } catch {
      toast.error('Failed to save document store settings');
    } finally {
      setDocStoreSaving(false);
    }
  };

  // Frida handlers
  const handleFridaSync = async () => {
    setFridaSyncing(true);
    try {
      await ws.sendRestApi('POST', '/v1/frida/releases/sync');
      await fetchFridaReleases();
      await fetchSettings();
      toast.success('Frida releases synced');
    } catch {
      toast.error('Failed to sync Frida releases');
    } finally {
      setFridaSyncing(false);
    }
  };

  const handleFridaDownload = async (version: string) => {
    setFridaDownloading(version);
    try {
      await ws.sendRestApi('POST', `/v1/frida/releases/${version}/download`);
      await fetchFridaReleases();
      toast.success('Frida release downloaded');
    } catch {
      toast.error('Failed to download Frida release');
    } finally {
      setFridaDownloading(null);
    }
  };

  const handleFridaDelete = async (version: string) => {
    try {
      await ws.sendRestApi('DELETE', `/v1/frida/releases/${version}`);
      await fetchFridaReleases();
      toast.success('Frida release deleted');
    } catch {
      toast.error('Failed to delete Frida release');
    }
  };

  const handleFridaDefaultVersion = async (version: string) => {
    setFridaDefaultVersion(version);
    try {
      await ws.sendRestApi('PUT', '/v1/settings/frida_default_version', { value: version });
    } catch {
      toast.error('Failed to set default Frida version');
    }
  };

  return (
    <div id="section-integrations">
      <SectionHeading>Integrations</SectionHeading>

      {/* ── Google Play ── */}
      <SectionCard
        id="google-play"
        title="Google Play APK Downloads"
        description="Optional credentials for downloading APKs directly from Google Play. Without credentials, APKPure is used as a fallback source (no auth needed)."
        status={googlePlayConfigured ? 'configured' : undefined}
      >
        <FieldRow style={{ marginBottom: 12 }}>
          <Field label="Google Account Email" width={280}>
            <input
              className="form-input"
              value={googlePlayEmail}
              onChange={e => setGooglePlayEmail(e.target.value)}
              placeholder="your.account@gmail.com"
              data-testid="google-play-email"
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="AAS Token" width={280}>
            <input
              className="form-input"
              type="password"
              value={googlePlayAasToken}
              onChange={e => setGooglePlayAasToken(e.target.value)}
              placeholder={googlePlayConfigured ? 'Enter new token to replace' : 'AAS token from apkeep --oauth-token'}
              data-testid="google-play-aas-token"
              style={{ width: '100%' }}
            />
          </Field>
        </FieldRow>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <SaveButton
            saving={googlePlaySaving}
            saved={googlePlaySaved}
            onClick={handleSaveGooglePlay}
            disabled={!googlePlayEmail && !googlePlayAasToken}
            testId="save-google-play-btn"
          />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Get token: <code style={{ fontSize: 11 }}>apkeep -e email --oauth-token OAUTH_TOKEN</code>
          </span>
        </div>
      </SectionCard>

      {/* NordVPN credentials moved to Settings → Proxies on 2026-05-13. */}

      {/* ── Document Store ── */}
      <SectionCard
        id="doc-store"
        title="Document Store"
        description={`Base URL for the external document store API. Used by documentStore.getDoc() / putDoc() in automations.`}
        status={docStoreConfigured ? 'configured' : 'not-configured'}
      >
        <FieldRow style={{ marginBottom: 12 }}>
          <Field label="API Base URL" width={360}>
            <input
              className="form-input"
              value={docStoreUrl}
              onChange={e => setDocStoreUrl(e.target.value)}
              placeholder="https://example.com/api"
              data-testid="doc-store-url"
              style={{ width: '100%' }}
            />
          </Field>
        </FieldRow>
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label>Custom Headers <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(sent on every request, e.g. Authorization)</span></label>
          <KeyValueEditor
            pairs={docStoreHeaders}
            onChange={setDocStoreHeaders}
            keyPlaceholder="Header name"
            valuePlaceholder="Header value"
            addLabel="Add Header"
            emptyText="No custom headers."
            valueType="password"
            testIdPrefix="doc-store-header"
          />
        </div>
        <SaveButton saving={docStoreSaving} saved={docStoreSaved} onClick={handleSaveDocStore} testId="save-doc-store-btn" />
      </SectionCard>

      {/* ── Frida ── */}
      <SectionCard
        id="frida"
        title="Frida Server"
        description="Manage Frida server versions for device instrumentation. Binaries are downloaded from GitHub releases."
      >
        <FieldRow style={{ marginBottom: 16 }}>
          <Field label="Default Version" width={220}>
            <select
              className="form-input"
              value={fridaDefaultVersion}
              onChange={e => handleFridaDefaultVersion(e.target.value)}
              data-testid="frida-default-version"
              style={{ width: '100%' }}
            >
              <option value="latest">Latest</option>
              {fridaReleases.map(r => (
                <option key={r.version} value={r.version}>{r.version}</option>
              ))}
            </select>
          </Field>
          <button
            className="btn btn-primary"
            onClick={handleFridaSync}
            disabled={fridaSyncing}
            data-testid="frida-sync-btn"
          >
            {fridaSyncing ? 'Syncing...' : 'Sync Now'}
          </button>
          {fridaLastSync && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', paddingBottom: 8 }}>
              Last synced: {new Date(fridaLastSync).toLocaleString()}
            </span>
          )}
        </FieldRow>

        {fridaReleases.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {fridaReleases.map(r => (
              <div
                key={r.version}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 10px', borderRadius: 6,
                  background: 'var(--bg-secondary)',
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500 }}>{r.version}</span>
                  <span className="hide-mobile" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {r.releaseDate ? new Date(r.releaseDate).toLocaleDateString() : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {r.isDownloaded ? (
                    <>
                      <span style={{ color: 'var(--success)', fontSize: 12 }}>
                        Downloaded{r.fileSize ? ` (${(r.fileSize / 1024 / 1024).toFixed(1)} MB)` : ''}
                      </span>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleFridaDelete(r.version)}
                        style={{ padding: '2px 8px', fontSize: 11 }}
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => handleFridaDownload(r.version)}
                      disabled={fridaDownloading === r.version}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                    >
                      {fridaDownloading === r.version ? 'Downloading...' : 'Download'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
