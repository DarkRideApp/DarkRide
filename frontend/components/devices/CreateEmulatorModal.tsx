import React, { useEffect, useState, useCallback } from 'react';
import { useWebSocket, useToast } from '@darkrideapp/plugin-sdk/react';
import { X, AlertCircle, RefreshCw, Info } from 'lucide-react';
import { ProviderTab, type FormField } from './ProviderTab';

interface Provider {
  id: string;
  displayName: string;
  available: boolean;
  installHint?: string;
  capabilities: { canCreate: boolean };
}

interface Props {
  onCancel: () => void;
  onCreated: () => void;
}

/**
 * Modal wizard for creating a new managed emulator instance.
 *
 * UX choices:
 *   - When only one provider supports createInstance (the typical case for
 *     most installs), tabs collapse — we just show the form.
 *   - Create is non-blocking: the modal closes the moment the `created`
 *     row exists. The actual emulator boot (~90s on KVM) is observable on
 *     the Devices page via the new managed-instance card with a "Booting"
 *     badge, driven by `provider-instance-updated` WebSocket broadcasts.
 *   - Unavailable providers get a real empty state with a Re-check button,
 *     not just a sentence of text.
 *
 * The form schema is fetched per provider from
 * `GET /v1/devices/providers/:id/create-form` so plugin-contributed
 * providers don't need any UI changes — they just declare their fields.
 */
export function CreateEmulatorModal({ onCancel, onCreated }: Props) {
  const ws = useWebSocket();
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [schema, setSchema] = useState<FormField[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  // Live status of an in-flight image pull. Backend broadcasts
  // `provider-image-pull-progress` with chunked Docker pull events when
  // createInstance has to materialize the image (first-time use). We just
  // surface the latest status string so the modal doesn't look frozen for
  // ~10 minutes during the first ~8GB pull.
  const [pullStatus, setPullStatus] = useState<string | null>(null);

  useEffect(() => {
    const unsub = ws.subscribe('provider-image-pull-progress', (msg: any) => {
      if (msg?.status === 'complete') { setPullStatus(null); return; }
      if (msg?.status === 'starting') { setPullStatus('Downloading image (one-time, ~8 GB unpacked)…'); return; }
      // Per-layer progress: "Downloading", "Extracting", "Pull complete"…
      const layer = msg?.id ? ` ${msg.id}` : '';
      const pd = msg?.progressDetail;
      let detail = '';
      if (pd?.current && pd?.total) {
        const pct = Math.floor((pd.current / pd.total) * 100);
        detail = ` ${pct}%`;
      }
      setPullStatus(`${msg.status ?? 'Pulling'}${layer}${detail}`);
    });
    return unsub;
  }, [ws]);

  const fetchProviders = useCallback(async () => {
    const r = await ws.sendRestApi('GET', '/v1/devices/providers');
    const all = (r.body?.data?.providers ?? []) as Provider[];
    const creatable = all.filter((p) => p.capabilities.canCreate);
    setProviders(creatable);
    if (creatable.length > 0 && !activeId) setActiveId(creatable[0].id);
    setProvidersLoaded(true);
  }, [ws, activeId]);

  useEffect(() => { void fetchProviders(); }, [fetchProviders]);

  useEffect(() => {
    if (!activeId) return;
    const active = providers.find((p) => p.id === activeId);
    if (!active?.available) {
      setSchema([]);
      return;
    }
    (async () => {
      const r = await ws.sendRestApi('GET', `/v1/devices/providers/${activeId}/create-form`);
      const fields = (r.body?.data?.fields ?? []) as FormField[];
      setSchema(fields);
      const initial: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.default !== undefined) initial[f.key] = f.default;
      }
      setConfig(initial);
    })();
  }, [activeId, providers, ws]);

  const active = providers.find((p) => p.id === activeId);

  async function reCheck() {
    setRechecking(true);
    try {
      await fetchProviders();
    } finally {
      setRechecking(false);
    }
  }

  async function submit() {
    if (!activeId || !active?.available || !displayName.trim()) return;
    setSubmitting(true);
    let createdOk = false;
    try {
      const r = await ws.sendRestApi('POST', `/v1/devices/providers/${activeId}/instances`, {
        displayName: displayName.trim(),
        config,
      });
      if (r.body?.success) {
        const instanceId = r.body.data.instance.id as number;
        // Fire-and-forget the start request. The Devices page subscribes to
        // provider-instance-updated and renders the boot progress; blocking
        // here would freeze the modal for ~90s with no feedback.
        void ws.sendRestApi(
          'POST',
          `/v1/devices/providers/${activeId}/instances/${instanceId}/start`,
        );
        toast.success(`"${displayName.trim()}" created — booting in the background`);
        createdOk = true;
        onCreated();
      } else {
        toast.error(r.body?.error ?? 'Failed to create emulator');
      }
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to create emulator');
    } finally {
      if (!createdOk) setSubmitting(false);
    }
  }

  const showTabs = providers.length > 1;
  const submitDisabled = submitting || !active?.available || !displayName.trim();

  return (
    <div className="modal-overlay" onClick={submitting ? undefined : onCancel}>
      <div
        className="modal modal-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-emulator-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="create-emulator-title">Create emulator</h2>
          <button
            className="modal-close"
            onClick={onCancel}
            aria-label="Close"
            disabled={submitting}
          >
            <X size={18} />
          </button>
        </div>

        {showTabs && (
          <div className="emulator-modal-tabs" role="tablist">
            {providers.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={p.id === activeId}
                className={`tab-btn${p.id === activeId ? ' active' : ''}`}
                onClick={() => setActiveId(p.id)}
                type="button"
              >
                {p.displayName}
                {!p.available && (
                  <span className="emulator-modal-tab-unavail" title="Not available">·</span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="modal-body">
          {!providersLoaded ? (
            <div className="emulator-modal-empty">Loading providers…</div>
          ) : providers.length === 0 ? (
            <div className="emulator-modal-empty">
              <AlertCircle size={28} aria-hidden />
              <div className="emulator-modal-empty-title">No emulator providers available</div>
              <div className="emulator-modal-empty-detail">
                Install Docker to enable docker-android, or the Android SDK
                (with avdmanager + emulator on PATH) to enable AVD.
              </div>
            </div>
          ) : active && !active.available ? (
            <div className="emulator-modal-empty">
              <AlertCircle size={28} aria-hidden />
              <div className="emulator-modal-empty-title">
                {active.displayName} isn't available on this host
              </div>
              <div className="emulator-modal-empty-detail">
                {active.installHint ?? 'See the provider docs for setup instructions.'}
              </div>
              <button
                className="btn btn-sm"
                onClick={reCheck}
                disabled={rechecking}
                type="button"
              >
                <RefreshCw
                  size={14}
                  style={{ marginRight: 6 }}
                  className={rechecking ? 'spin' : undefined}
                />
                {rechecking ? 'Re-checking…' : 'Re-check availability'}
              </button>
            </div>
          ) : active ? (
            <>
              <ProviderTab
                schema={schema}
                displayName={displayName}
                setDisplayName={setDisplayName}
                config={config}
                setConfig={setConfig}
              />
              <div className="emulator-modal-hint">
                <Info size={14} aria-hidden />
                <span>
                  Cold boot takes ~90 seconds. The instance appears in your
                  device list once it's ready.
                </span>
              </div>
            </>
          ) : null}
        </div>

        <div className="modal-footer">
          <button
            className="btn btn-ghost"
            onClick={onCancel}
            disabled={submitting}
            type="button"
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={submitDisabled}
            type="button"
            title={
              !active?.available
                ? 'Provider not available on this host'
                : !displayName.trim()
                  ? 'Enter a name to continue'
                  : undefined
            }
          >
            {submitting ? (pullStatus ?? 'Creating…') : 'Create & start'}
          </button>
        </div>
      </div>
    </div>
  );
}
