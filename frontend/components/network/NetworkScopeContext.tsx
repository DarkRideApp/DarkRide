import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export type NetworkScope =
  | { kind: 'all' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'session'; sessionId: number };

/** Parse the `?scope=` URL param into a NetworkScope. Unknown/garbage -> all. */
export function parseScopeParam(raw: string | null): NetworkScope {
  if (!raw || raw === 'all') return { kind: 'all' };
  const [kind, ...rest] = raw.split(':');
  const value = rest.join(':');
  // Allow an empty deviceId ("device:") so selecting the Device scope before a
  // device is chosen still renders the picker instead of snapping back to All.
  if (kind === 'device') return { kind: 'device', deviceId: value };
  if (kind === 'session') {
    const n = parseInt(value, 10);
    if (!isNaN(n)) return { kind: 'session', sessionId: n };
  }
  return { kind: 'all' };
}

/** Serialize a scope to the `?scope=` value (undefined for all -> omit the param). */
export function scopeToParam(scope: NetworkScope): string | undefined {
  switch (scope.kind) {
    case 'device': return `device:${scope.deviceId}`;
    case 'session': return `session:${scope.sessionId}`;
    default: return undefined;
  }
}

/** Derive the /traffic list+tree query params a scope implies. */
export function scopeToTrafficParams(scope: NetworkScope): { deviceId?: string; sessionId?: number } {
  switch (scope.kind) {
    case 'device': return { deviceId: scope.deviceId };
    case 'session': return { sessionId: scope.sessionId };
    default: return {};
  }
}

interface NetworkScopeValue {
  scope: NetworkScope;
  setScope: (scope: NetworkScope) => void;
}

const NetworkScopeCtx = createContext<NetworkScopeValue | null>(null);

/** Provides the current scope, kept in sync with the `?scope=` URL param. */
export function NetworkScopeProvider({ children }: { children: React.ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = useMemo(() => parseScopeParam(searchParams.get('scope')), [searchParams]);
  const setScope = useCallback((next: NetworkScope) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      const val = scopeToParam(next);
      if (val) p.set('scope', val); else p.delete('scope');
      return p;
    }, { replace: false });
  }, [setSearchParams]);
  const value = useMemo(() => ({ scope, setScope }), [scope, setScope]);
  return <NetworkScopeCtx.Provider value={value}>{children}</NetworkScopeCtx.Provider>;
}

export function useNetworkScope(): NetworkScopeValue {
  const ctx = useContext(NetworkScopeCtx);
  if (!ctx) throw new Error('useNetworkScope must be used within a NetworkScopeProvider');
  return ctx;
}
