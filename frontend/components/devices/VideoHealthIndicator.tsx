import React from 'react';

export type HealthState = 'healthy' | 'degraded' | 'resetting';

export interface VideoHealthIndicatorProps {
  state: HealthState;
  tier: number;
  bitrate: number;
}

export function VideoHealthIndicator({ state, tier, bitrate }: VideoHealthIndicatorProps) {
  const title = `Video stream — tier ${tier} (${bitrate} bps)`;
  return <span className={`video-health-dot ${state}`} title={title} aria-label={title} />;
}
