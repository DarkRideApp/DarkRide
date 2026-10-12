import React, { useState } from 'react';

const CUSTOM = '__custom__';

export interface KnownOption { value: string; description: string }

/**
 * Shared "pick a registered function/event, or type a custom one" control — the same pattern
 * previously hand-rolled three times (Trigger's expand functions, Sink's write functions, and
 * now Trigger's event sources / Transform's functions). `forceCustom` fixes the bug from commit
 * 98d8900: selecting Custom saves an empty value, which is ambiguous with "nothing chosen yet"
 * — local state remembers the explicit choice independent of the current value.
 */
export function KnownOptionPicker({ id, label, options, value, onPick, onCustomType, help, customPlaceholder = 'custom value' }: {
  id: string;
  label: string;
  options: KnownOption[];
  value: string;
  onPick: (value: string) => void;
  onCustomType: (value: string) => void;
  help?: string;
  customPlaceholder?: string;
}) {
  const known = options.find(o => o.value === value);
  const [forceCustom, setForceCustom] = useState(false);
  const isKnown = !forceCustom && (value === '' || known !== undefined);

  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="form-select" value={isKnown ? value : CUSTOM}
        onChange={(e) => {
          const isCustom = e.target.value === CUSTOM;
          setForceCustom(isCustom);
          onPick(isCustom ? '' : e.target.value);
        }}>
        <option value="">— choose —</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.value}</option>)}
        <option value={CUSTOM}>Custom (registered in code)…</option>
      </select>
      {!isKnown && (
        <input className="form-input" value={value} placeholder={customPlaceholder} onChange={(e) => onCustomType(e.target.value)} />
      )}
      {(known || help) && <div className="form-help">{known ? known.description : help}</div>}
    </div>
  );
}
