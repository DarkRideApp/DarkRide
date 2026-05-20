import React, { useEffect, useState } from 'react';
import { useWebSocket, useToast } from '@darkrideapp/plugin-sdk/react';
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
 * Modal wizard for creating a new managed emulator instance. One tab per
 * provider that supports createInstance. Unavailable providers (e.g. no
 * Docker daemon) render an installHint instead of the form.
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

  useEffect(() => {
    (async () => {
      const r = await ws.sendRestApi('GET', '/v1/devices/providers');
      const all = (r.body?.data?.providers ?? []) as Provider[];
      const creatable = all.filter((p) => p.capabilities.canCreate);
      setProviders(creatable);
      if (creatable.length > 0) setActiveId(creatable[0].id);
    })();
  }, [ws]);

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

  async function submit() {
    if (!activeId || !active?.available || !displayName.trim()) return;
    setSubmitting(true);
    try {
      const r = await ws.sendRestApi('POST', `/v1/devices/providers/${activeId}/instances`, {
        displayName: displayName.trim(),
        config,
      });
      if (r.body?.success) {
        toast.success(`Emulator "${displayName}" created — starting...`);
        // Auto-start
        await ws.sendRestApi('POST', `/v1/devices/providers/${activeId}/instances/${r.body.data.instance.id}/start`);
        onCreated();
      } else {
        toast.error(r.body?.error ?? 'Create failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal create-emulator-modal">
        <div className="modal-header">
          <h2>Create emulator</h2>
          <button onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="modal-tabs" role="tablist">
          {providers.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === activeId}
              className={p.id === activeId ? 'tab active' : 'tab'}
              onClick={() => setActiveId(p.id)}
            >
              {p.displayName}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {active && !active.available && (
            <div className="provider-unavailable">
              <p>{active.installHint ?? `${active.displayName} is not available on this host.`}</p>
            </div>
          )}
          {active && active.available && (
            <ProviderTab
              schema={schema}
              displayName={displayName}
              setDisplayName={setDisplayName}
              config={config}
              setConfig={setConfig}
            />
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onCancel}>Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !active?.available || !displayName.trim()}
            className="btn-primary"
          >
            {submitting ? 'Creating...' : 'Create & start'}
          </button>
        </div>
      </div>
    </div>
  );
}
