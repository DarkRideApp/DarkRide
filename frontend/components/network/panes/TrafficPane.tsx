import React from 'react';
import { Traffic } from '../../../pages/Traffic';
import { scopeToTrafficParams, type NetworkScope } from '../NetworkScopeContext';

/** Traffic table + host/path tree, scoped by the workspace scope bar. */
export function TrafficPane({ scope }: { scope: NetworkScope }) {
  const { deviceId, sessionId } = scopeToTrafficParams(scope);
  return <Traffic scopeDeviceId={deviceId ?? null} scopeSessionId={sessionId ?? null} />;
}
