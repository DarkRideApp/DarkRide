import React from 'react';
import { InterceptArmControl, InterceptHoldPanel } from '../../intercept/InterceptHoldPanel';

/** Interactive interception (breakpoints) promoted to a first-class pane. */
export function InterceptPane() {
  return (
    <div className="network-pane-intercept" data-testid="pane-intercept" style={{ padding: 24 }}>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
        Arm interception to pause matching requests or responses in flight, then edit, forward, or drop them.
      </p>
      <InterceptArmControl />
      <InterceptHoldPanel />
    </div>
  );
}
