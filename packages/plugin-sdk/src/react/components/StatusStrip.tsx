import React from 'react';

export interface StatusStripProps {
  label: string;
  /** 0-100; bar hidden when null/undefined */
  progress?: number | null;
  detail?: string;
  variant?: 'info' | 'success' | 'error';
  onCancel?: () => void;
  'data-testid'?: string;
}

/**
 * Inline status banner for live runs (re-analyze, AI review, diff).
 * Keeps action buttons' labels stable by giving run state its own surface.
 * Styling via host classes `.status-strip*`.
 */
export function StatusStrip({ label, progress, detail, variant = 'info', onCancel, 'data-testid': testId }: StatusStripProps) {
  const clamped = progress != null ? Math.min(100, Math.max(0, progress)) : null;
  return (
    <div className={`status-strip status-strip-${variant}`} data-testid={testId}>
      <span className="status-strip-dot" aria-hidden="true" />
      <span className="status-strip-label">{label}</span>
      {clamped != null && (
        <div className="status-strip-bar" role="progressbar" aria-label={label} aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
          <div className="status-strip-bar-fill" style={{ width: `${clamped}%` }} />
        </div>
      )}
      {detail && <span className="status-strip-detail">{detail}</span>}
      {onCancel && <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
