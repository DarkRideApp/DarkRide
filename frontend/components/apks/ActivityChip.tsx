import React from 'react';
import { useAnalysisActivity } from './useAnalysisActivity';

interface ActivityChipProps {
  onClick: () => void;
}

/** Toolbar chip summarising analysis activity. States: running > failed > idle. */
export function ActivityChip({ onClick }: ActivityChipProps) {
  const { active, unseenFailed } = useAnalysisActivity();

  let className = 'activity-chip';
  let label = 'Activity';
  if (active.length > 0) {
    className += ' activity-chip-running';
    label = `${active.length} job${active.length !== 1 ? 's' : ''}`;
  } else if (unseenFailed.length > 0) {
    className += ' activity-chip-failed';
    label = `${unseenFailed.length} failed`;
  }

  return (
    <button className={className} onClick={onClick} data-testid="activity-chip" title="Analysis activity">
      {(active.length > 0 || unseenFailed.length > 0) && <span className="activity-chip-dot" aria-hidden="true" />}
      {label}
    </button>
  );
}
