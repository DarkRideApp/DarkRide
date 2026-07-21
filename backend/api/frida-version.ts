/**
 * Pure decision helper for the frida-server start short-circuit.
 *
 * The on-device server binary must be version-matched to the host client, or
 * device spawning becomes unreliable. Responsiveness alone is not enough: a
 * stale, mismatched binary can still answer probes. This decides whether the
 * binary needs to be re-pushed based on both responsiveness and version.
 */
export function fridaServerNeedsRepush(opts: {
  /** Whether the on-device server answered a probe. */
  responsive: boolean;
  /** Trimmed `frida-server --version` output, or null if unknown/binary missing. */
  deviceVersion: string | null;
  /** Resolved target version, or null if it could not be resolved. */
  targetVersion: string | null;
}): boolean {
  const device = opts.deviceVersion?.trim() || null;
  const target = opts.targetVersion?.trim() || null;
  // Safe to skip the push ONLY when the server answers AND both versions are
  // known AND they match. Any unknown or mismatch forces a re-push.
  const canSkip = opts.responsive && !!device && !!target && device === target;
  return !canSkip;
}
