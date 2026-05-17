import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'darkride.video.tier';

export interface VideoQualitySelectorProps {
  onChange: (tier: number | null) => void;
  /** Current tier reported by the backend (for the Auto label). */
  autoTier?: number;
}

const TIER_LABELS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: '0', label: '8 Mbps' },
  { value: '1', label: '4 Mbps' },
  { value: '2', label: '2 Mbps' },
  { value: '3', label: '1 Mbps' },
  { value: '4', label: '500 kbps' },
];

export function VideoQualitySelector({ onChange, autoTier }: VideoQualitySelectorProps) {
  const [value, setValue] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? 'auto'; } catch { return 'auto'; }
  });

  // Apply persisted value on mount
  useEffect(() => {
    if (value === 'auto') onChange(null);
    else onChange(Number(value));
    // Run only on mount; subsequent changes go through handleChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = useCallback((next: string) => {
    setValue(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
    onChange(next === 'auto' ? null : Number(next));
  }, [onChange]);

  return (
    <select
      className="video-quality-selector"
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      title="Video quality (manual override)"
      aria-label="Video quality"
    >
      {TIER_LABELS.map(t => (
        <option key={t.value} value={t.value}>
          {t.label}{t.value === 'auto' && autoTier !== undefined ? ` (tier ${autoTier})` : ''}
        </option>
      ))}
    </select>
  );
}
