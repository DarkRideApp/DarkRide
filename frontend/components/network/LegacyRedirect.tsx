import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

/**
 * Redirect a pre-workspace route (/ui/traffic, /ui/request-builder, ...) into
 * the matching Network workspace pane. A plain <Navigate to="...?pane=x"> would
 * drop the incoming query string, and several callers depend on it
 * (?replay=1 from Traffic's Replay button, ?url=&method= from the API
 * Explorer, ?tab=saved bookmarks). Carry every param and the hash across; the
 * route's own pane always wins over a stray ?pane= on the old URL.
 */
export function LegacyNetworkRedirect({ pane }: { pane: string }) {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.delete('pane');
  const rest = params.toString();
  const to = `/ui/network?pane=${encodeURIComponent(pane)}${rest ? `&${rest}` : ''}${hash}`;
  return <Navigate to={to} replace />;
}
