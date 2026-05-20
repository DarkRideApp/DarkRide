import React from 'react';

interface Props {
  providerId: string;
}

/**
 * Maps the runtime `providerId` (e.g. 'adb-device', 'avd', 'docker-android',
 * 'ios-device', or any plugin-defined ID like 'corellium-cloud') to a short
 * human-readable label rendered as a chip alongside each device on the
 * Devices page.
 *
 * - 'adb-device' → 'physical' (the BYOE/observe-only path is most often a
 *    physical phone; AVDs spawned via the `avd` provider get the richer
 *    'avd' badge instead — DeviceManager dedupes by serial and prefers
 *    the spawning provider).
 * - 'avd' / 'docker-android' / 'ios-device' → friendly short forms.
 * - Anything else: render the providerId verbatim (plugin providers).
 */
const KNOWN_LABELS: Record<string, string> = {
  'adb-device': 'physical',
  'avd': 'avd',
  'docker-android': 'docker',
  'ios-device': 'ios',
};

export function DeviceTypeBadge({ providerId }: Props) {
  const label = KNOWN_LABELS[providerId] ?? providerId;
  return <span className="device-type-badge">{label}</span>;
}
