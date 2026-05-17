import React from 'react';
import type { AvailabilityState } from './AvailabilityBadge';

type ApkSource = 'device' | 'playstore' | 'upload';

interface Props {
  state: AvailabilityState;
  source: ApkSource;
  onRestore: () => void;
  deviceConnected?: boolean;
  deviceName?: string;
}

/**
 * Card rendered inside source.db-backed tabs (code / strings / assets / reactnative)
 * when a version isn't local. Shows a state-appropriate action button; never
 * auto-triggers work — the user must click.
 */
export function NonLocalEmptyState(props: Props): JSX.Element {
  const { label, disabled, title } = buildAction(props);
  return (
    <div className="empty-state non-local-empty-state">
      <p>This version's decompiled data isn't on disk.</p>
      <button type="button" onClick={props.onRestore} disabled={disabled} title={title}>
        {label}
      </button>
    </div>
  );
}

function buildAction(props: Props): { label: string; disabled: boolean; title?: string } {
  const { state, source, deviceConnected, deviceName } = props;
  if (state === 'cloud') {
    return { label: 'Restore from cloud (~10s)', disabled: false };
  }
  if (state === 'needs-reanalyze') {
    return { label: 'Re-analyze APK (~2min)', disabled: false };
  }
  // lost
  if (source === 'device') {
    return {
      label: `Reconnect ${deviceName ?? 'device'} to re-fetch`,
      disabled: !deviceConnected,
      title: deviceConnected ? undefined : 'Device is not connected',
    };
  }
  if (source === 'playstore') {
    return {
      label: 'Re-fetch from Play Store',
      disabled: true,
      title: 'Re-fetch from Play Store is not supported in this release',
    };
  }
  return {
    label: 'Upload fresh copy',
    disabled: true,
    title: 'Upload a fresh copy manually to restore',
  };
}
