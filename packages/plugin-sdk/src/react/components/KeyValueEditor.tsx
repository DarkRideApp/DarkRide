export interface KeyValuePair {
  key: string;
  value: string;
}

interface KeyValueEditorProps {
  pairs: KeyValuePair[];
  onChange: (pairs: KeyValuePair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  emptyText?: string;
  valueType?: 'text' | 'password';
  testIdPrefix?: string;
  disabled?: boolean;
}

export function KeyValueEditor({
  pairs,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  addLabel = 'Add',
  emptyText = 'None configured.',
  valueType = 'text',
  testIdPrefix = 'kv',
  disabled = false,
}: KeyValueEditorProps) {
  const updatePair = (idx: number, patch: Partial<KeyValuePair>) => {
    const next = pairs.slice();
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const removePair = (idx: number) => {
    const next = pairs.slice();
    next.splice(idx, 1);
    onChange(next);
  };

  const addPair = () => {
    onChange([...pairs, { key: '', value: '' }]);
  };

  return (
    <div data-testid={`${testIdPrefix}-editor`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {pairs.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '4px 0' }}>{emptyText}</div>
      ) : (
        pairs.map((pair, idx) => (
          <div
            key={idx}
            data-testid={`${testIdPrefix}-row-${idx}`}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <input
              className="form-input"
              value={pair.key}
              onChange={e => updatePair(idx, { key: e.target.value })}
              placeholder={keyPlaceholder}
              disabled={disabled}
              data-testid={`${testIdPrefix}-key-${idx}`}
              style={{ flex: 1, minWidth: 0 }}
            />
            <input
              className="form-input"
              type={valueType}
              value={pair.value}
              onChange={e => updatePair(idx, { value: e.target.value })}
              placeholder={valuePlaceholder}
              disabled={disabled}
              data-testid={`${testIdPrefix}-value-${idx}`}
              style={{ flex: 2, minWidth: 0 }}
            />
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => removePair(idx)}
              disabled={disabled}
              data-testid={`${testIdPrefix}-remove-${idx}`}
              style={{ padding: '4px 8px', fontSize: 11, flexShrink: 0 }}
              aria-label="Remove"
            >
              ×
            </button>
          </div>
        ))
      )}
      <div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={addPair}
          disabled={disabled}
          data-testid={`${testIdPrefix}-add`}
          style={{ padding: '2px 10px', fontSize: 11 }}
        >
          + {addLabel}
        </button>
      </div>
    </div>
  );
}

/** Convert a list of pairs to a plain object. Empty keys are dropped. Later keys win on collision. */
export function pairsToObject(pairs: KeyValuePair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (!k) continue;
    out[k] = value;
  }
  return out;
}

/** Convert an object back to a list of pairs, preserving insertion order. */
export function objectToPairs(obj: Record<string, string> | null | undefined): KeyValuePair[] {
  if (!obj) return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }));
}
