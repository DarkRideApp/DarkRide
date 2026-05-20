import React from 'react';

export interface FormField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

interface Props {
  schema: FormField[];
  displayName: string;
  setDisplayName: (v: string) => void;
  config: Record<string, unknown>;
  setConfig: (v: Record<string, unknown>) => void;
}

/**
 * Renders the per-provider config form from a JSON schema returned by
 * `GET /v1/devices/providers/:id/create-form`. Each field type renders
 * the obvious HTML control.
 */
export function ProviderTab({ schema, displayName, setDisplayName, config, setConfig }: Props) {
  return (
    <form className="provider-tab" onSubmit={(e) => e.preventDefault()}>
      <label className="form-row" htmlFor="provider-tab-name">
        <span>Name</span>
        <input
          id="provider-tab-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="my-emulator"
        />
      </label>
      {schema.map((f) => (
        <label key={f.key} className="form-row" htmlFor={`field-${f.key}`}>
          <span>{f.label}</span>
          {f.type === 'select' && (
            <select
              id={`field-${f.key}`}
              value={String(config[f.key] ?? f.default ?? '')}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            >
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {f.type === 'number' && (
            <input
              id={`field-${f.key}`}
              type="number"
              value={Number(config[f.key] ?? f.default ?? 0)}
              onChange={(e) => setConfig({ ...config, [f.key]: Number(e.target.value) })}
            />
          )}
          {f.type === 'string' && (
            <input
              id={`field-${f.key}`}
              type="text"
              value={String(config[f.key] ?? f.default ?? '')}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            />
          )}
          {f.type === 'boolean' && (
            <input
              id={`field-${f.key}`}
              type="checkbox"
              checked={Boolean(config[f.key] ?? f.default)}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.checked })}
            />
          )}
          {f.help && <small>{f.help}</small>}
        </label>
      ))}
    </form>
  );
}
