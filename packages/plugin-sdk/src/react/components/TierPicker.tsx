import { useId } from 'react';
import type { AiTier } from '../hooks/ai-tier-types';

interface TierPickerProps {
  tiers: AiTier[];
  value: string;
  onChange: (tierName: string) => void;
  label?: string;
  id?: string;
}

export function TierPicker({ tiers, value, onChange, label, id }: TierPickerProps) {
  const generatedId = useId();
  const htmlId = id ?? generatedId;
  return (
    <div>
      {label && (
        <label htmlFor={htmlId} style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
          {label}
        </label>
      )}
      <select
        id={htmlId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%', padding: '6px 10px', fontSize: 13,
          background: 'var(--bg-secondary)', color: 'var(--text-primary)',
          border: '1px solid var(--border-color)', borderRadius: 4,
        }}
      >
        {tiers.map(t => (
          <option key={t.id} value={t.name}>
            {t.name}{t.enabledModelCount === 0 ? ' (empty)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
