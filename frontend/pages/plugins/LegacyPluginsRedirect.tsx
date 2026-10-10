import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { PluginTab } from './catalog';

/**
 * Redirect a pre-workspace route (/ui/marketplace, /ui/settings/plugins, ...)
 * into the matching Plugins workspace tab. Carries the query string and hash
 * across so existing bookmarks and links keep their search. The route's own
 * tab always wins over a stray ?tab= on the old URL.
 */
export function LegacyPluginsRedirect({ tab }: { tab: PluginTab }) {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  params.delete('tab');
  const rest = params.toString();
  const to = `/ui/plugins?tab=${tab}${rest ? `&${rest}` : ''}${hash}`;
  return <Navigate to={to} replace />;
}
