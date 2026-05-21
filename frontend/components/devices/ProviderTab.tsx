import React from 'react';

export interface FormField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  help?: string;
  /** Inclusive min for number fields. */
  min?: number;
  /** Inclusive max for number fields. */
  max?: number;
  /** Numeric step for number fields. */
  step?: number;
  placeholder?: string;
}

interface Props {
  schema: FormField[];
  displayName: string;
  setDisplayName: (v: string) => void;
  config: Record<string, unknown>;
  setConfig: (v: Record<string, unknown>) => void;
}

/**
 * Renders the per-provider config form from a schema returned by
 * `GET /v1/devices/providers/:id/create-form`. One control per field; help
 * text rendered as `.form-help` to match the rest of the app's forms.
 *
 * Uses `.form-group` (vertical label + control) — the surrounding `.modal-body`
 * is the flex parent that stacks groups; we don't add another wrapper.
 */
export function ProviderTab({ schema, displayName, setDisplayName, config, setConfig }: Props) {
  return (
    <form className="emulator-modal-form" onSubmit={(e) => e.preventDefault()}>
      <div className="form-group">
        <label htmlFor="provider-tab-name">
          Name <span className="form-required">*</span>
        </label>
        <input
          id="provider-tab-name"
          className="form-input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="my-emulator"
          autoFocus
        />
        <div className="form-help">A label for this emulator in your devices list.</div>
      </div>

      {schema.map((f) => {
        const fieldId = `field-${f.key}`;
        if (f.type === 'select') {
          return (
            <div key={f.key} className="form-group">
              <label htmlFor={fieldId}>
                {f.label}
                {f.required && <span className="form-required"> *</span>}
              </label>
              <select
                id={fieldId}
                className="form-select"
                value={String(config[f.key] ?? f.default ?? '')}
                onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
              >
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {f.help && <div className="form-help">{f.help}</div>}
            </div>
          );
        }
        if (f.type === 'number') {
          const current = config[f.key];
          const numVal = typeof current === 'number' ? current : (typeof f.default === 'number' ? f.default : 0);
          const outOfRange =
            (typeof f.min === 'number' && numVal < f.min) ||
            (typeof f.max === 'number' && numVal > f.max);
          const helpParts: string[] = [];
          if (typeof f.min === 'number' && typeof f.max === 'number') {
            helpParts.push(`${f.min.toLocaleString()}–${f.max.toLocaleString()}`);
          } else if (typeof f.min === 'number') {
            helpParts.push(`min ${f.min.toLocaleString()}`);
          } else if (typeof f.max === 'number') {
            helpParts.push(`max ${f.max.toLocaleString()}`);
          }
          if (f.help) helpParts.push(f.help);
          return (
            <div key={f.key} className="form-group">
              <label htmlFor={fieldId}>
                {f.label}
                {f.required && <span className="form-required"> *</span>}
              </label>
              <input
                id={fieldId}
                className={outOfRange ? 'form-input form-input-error' : 'form-input'}
                type="number"
                value={numVal}
                min={f.min}
                max={f.max}
                step={f.step ?? 1}
                onChange={(e) => setConfig({ ...config, [f.key]: Number(e.target.value) })}
              />
              {helpParts.length > 0 && (
                <div className="form-help">{helpParts.join(' · ')}</div>
              )}
            </div>
          );
        }
        if (f.type === 'boolean') {
          return (
            <div key={f.key} className="form-group">
              <label className="form-checkbox-label" htmlFor={fieldId}>
                <input
                  id={fieldId}
                  type="checkbox"
                  checked={Boolean(config[f.key] ?? f.default)}
                  onChange={(e) => setConfig({ ...config, [f.key]: e.target.checked })}
                />
                <span>
                  {f.label}
                  {f.required && <span className="form-required"> *</span>}
                </span>
              </label>
              {f.help && <div className="form-help">{f.help}</div>}
            </div>
          );
        }
        // f.type === 'string'
        return (
          <div key={f.key} className="form-group">
            <label htmlFor={fieldId}>
              {f.label}
              {f.required && <span className="form-required"> *</span>}
            </label>
            <input
              id={fieldId}
              className="form-input"
              type="text"
              value={String(config[f.key] ?? f.default ?? '')}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
              placeholder={f.placeholder}
            />
            {f.help && <div className="form-help">{f.help}</div>}
          </div>
        );
      })}
    </form>
  );
}
