import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useToast } from '@darkrideapp/plugin-sdk/react';
import {
  SectionCard, SectionHeading, FieldRow, Field, SaveButton,
  CLOUD_PROVIDER_OPTIONS,
} from './SettingsShared';
import type { CloudProvider } from './SettingsShared';
import type { Setting } from '../../../shared/types/api';

export function CloudStorageSection() {
  const ws = useWebSocket();
  const toast = useToast();

  const [cloudProvider, setCloudProvider] = useState<CloudProvider>('');
  const [cloudEndpoint, setCloudEndpoint] = useState('');
  const [cloudRegion, setCloudRegion] = useState('');
  const [cloudBucket, setCloudBucket] = useState('');
  const [cloudAccessKey, setCloudAccessKey] = useState('');
  const [cloudSecretKey, setCloudSecretKey] = useState('');
  const [cloudCacheMb, setCloudCacheMb] = useState('5000');
  const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudSaved, setCloudSaved] = useState(false);
  const [cloudTesting, setCloudTesting] = useState(false);
  const [cloudTestResult, setCloudTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [cloudKeyExists, setCloudKeyExists] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await ws.sendRestApi('GET', '/v1/settings/list');
      const data: Setting[] = res.body?.data || [];
      const map = new Map(data.map((s) => [s.key, s.value]));

      setCloudProvider((map.get('cloud_provider') || '') as CloudProvider);
      setCloudEndpoint(map.get('cloud_endpoint') || '');
      setCloudRegion(map.get('cloud_region') || '');
      setCloudBucket(map.get('cloud_bucket') || '');
      setCloudCacheMb(map.get('cloud_local_cache_mb') || '5000');
      setCloudKeyExists(map.has('cloud_access_key'));
    } catch {}
  }, [ws]);

  useEffect(() => {
    if (ws.connected) fetchSettings();
  }, [ws.connected, fetchSettings]);

  const handleSaveCloud = async () => {
    setCloudSaving(true);
    setCloudSaved(false);
    try {
      await ws.sendRestApi('PUT', '/v1/settings/cloud_provider', { value: cloudProvider });
      await ws.sendRestApi('PUT', '/v1/settings/cloud_endpoint', { value: cloudEndpoint });
      await ws.sendRestApi('PUT', '/v1/settings/cloud_region', { value: cloudRegion });
      await ws.sendRestApi('PUT', '/v1/settings/cloud_bucket', { value: cloudBucket });
      await ws.sendRestApi('PUT', '/v1/settings/cloud_local_cache_mb', { value: cloudCacheMb });
      if (cloudAccessKey) {
        await ws.sendRestApi('PUT', '/v1/settings/cloud_access_key', { value: cloudAccessKey });
        setCloudKeyExists(true);
        setCloudAccessKey('');
      }
      if (cloudSecretKey) {
        await ws.sendRestApi('PUT', '/v1/settings/cloud_secret_key', { value: cloudSecretKey });
        setCloudSecretKey('');
      }
      await ws.sendRestApi('POST', '/v1/cloud/configure');
      setCloudSaved(true);
      setTimeout(() => setCloudSaved(false), 3000);
      toast.success('Cloud storage settings saved');
    } catch {
      toast.error('Failed to save cloud storage settings');
    } finally {
      setCloudSaving(false);
    }
  };

  const handleTestCloud = async () => {
    setCloudTesting(true);
    setCloudTestResult(null);
    try {
      const res = await ws.sendRestApi('POST', '/v1/cloud/test');
      if (res.body?.success) {
        setCloudTestResult({ success: true, message: res.body.message || 'Connection successful' });
      } else {
        setCloudTestResult({ success: false, message: res.body?.error || 'Connection failed' });
      }
    } catch (err: any) {
      setCloudTestResult({ success: false, message: err.message || 'Connection failed' });
    } finally {
      setCloudTesting(false);
    }
  };

  return (
    <div id="section-cloud">
      <SectionHeading>Cloud Storage</SectionHeading>

      <SectionCard
        id="cloud-storage"
        title="S3-Compatible Storage"
        description="APK backups and daily database backups. Supports AWS S3, Backblaze B2, Cloudflare R2, or any S3-compatible provider."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FieldRow>
            <Field label="Provider" width={220}>
              <select
                className="form-input"
                value={cloudProvider}
                onChange={e => setCloudProvider(e.target.value as CloudProvider)}
                data-testid="cloud-provider-select"
                style={{ width: '100%' }}
              >
                {CLOUD_PROVIDER_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
          </FieldRow>

          {cloudProvider && (
            <>
              <FieldRow>
                <Field label="Endpoint" width={360}>
                  <input
                    className="form-input"
                    value={cloudEndpoint}
                    onChange={e => setCloudEndpoint(e.target.value)}
                    placeholder={cloudProvider === 'b2' ? 's3.us-west-000.backblazeb2.com' : cloudProvider === 'r2' ? 'ACCOUNT_ID.r2.cloudflarestorage.com' : 's3.us-east-1.amazonaws.com'}
                    data-testid="cloud-endpoint"
                    style={{ width: '100%' }}
                  />
                </Field>
                <Field label="Region" width={160}>
                  <input
                    className="form-input"
                    value={cloudRegion}
                    onChange={e => setCloudRegion(e.target.value)}
                    placeholder={cloudProvider === 'r2' ? 'auto' : 'us-east-1'}
                    data-testid="cloud-region"
                    style={{ width: '100%' }}
                  />
                </Field>
              </FieldRow>

              <FieldRow>
                <Field label="Bucket" width={260}>
                  <input
                    className="form-input"
                    value={cloudBucket}
                    onChange={e => setCloudBucket(e.target.value)}
                    placeholder="darkride-backup"
                    data-testid="cloud-bucket"
                    style={{ width: '100%' }}
                  />
                </Field>
                <Field label="Local Cache Budget (MB)" width={120}>
                  <input
                    className="form-input"
                    type="number"
                    value={cloudCacheMb}
                    onChange={e => setCloudCacheMb(e.target.value)}
                    placeholder="5000"
                    data-testid="cloud-cache-mb"
                    style={{ width: '100%' }}
                  />
                </Field>
              </FieldRow>

              <FieldRow>
                <Field label="Access Key" width={260}>
                  <input
                    className="form-input"
                    type="password"
                    value={cloudAccessKey}
                    onChange={e => setCloudAccessKey(e.target.value)}
                    placeholder={cloudKeyExists ? 'Enter new key to replace' : 'Access Key ID'}
                    data-testid="cloud-access-key"
                    style={{ width: '100%' }}
                  />
                </Field>
                <Field label="Secret Key" width={260}>
                  <input
                    className="form-input"
                    type="password"
                    value={cloudSecretKey}
                    onChange={e => setCloudSecretKey(e.target.value)}
                    placeholder="Enter secret key"
                    data-testid="cloud-secret-key"
                    style={{ width: '100%' }}
                  />
                </Field>
              </FieldRow>

              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <SaveButton saving={cloudSaving} saved={cloudSaved} onClick={handleSaveCloud} testId="save-cloud-btn" />
                <button
                  className="btn"
                  onClick={handleTestCloud}
                  disabled={cloudTesting}
                  data-testid="test-cloud-btn"
                >
                  {cloudTesting ? 'Testing...' : 'Test Connection'}
                </button>
                {cloudTestResult && (
                  <span style={{
                    fontSize: 13,
                    color: cloudTestResult.success ? 'var(--success)' : 'var(--danger)',
                  }}>
                    {cloudTestResult.message}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
