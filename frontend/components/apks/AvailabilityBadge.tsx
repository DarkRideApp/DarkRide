import React from 'react';

export type AvailabilityState = 'local' | 'cloud' | 'needs-reanalyze' | 'lost';

const LABELS: Record<AvailabilityState, string> = {
  local: 'Local',
  cloud: 'Cloud',
  'needs-reanalyze': 'Needs re-analyze',
  lost: 'Lost',
};

const COLOR_CLASSES: Record<AvailabilityState, string> = {
  local: 'badge badge-success',
  cloud: 'badge badge-warning',
  'needs-reanalyze': 'badge badge-warning',
  lost: 'badge badge-error',
};

interface Props {
  state: AvailabilityState;
  loading?: boolean;
  title?: string;
}

export function AvailabilityBadge({ state, loading, title }: Props): JSX.Element {
  if (loading) {
    return <span className="badge badge-muted" title={title}>Restoring…</span>;
  }
  return (
    <span className={COLOR_CLASSES[state]} title={title}>
      {LABELS[state]}
    </span>
  );
}
