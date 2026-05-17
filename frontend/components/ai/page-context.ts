export interface PluginToolContext {
  id: string;
  urlPattern?: string;
  contextIdParam?: string;
}

/** Match a pathname against plugin tool context URL patterns */
export function matchPluginContext(
  pathname: string,
  contexts: PluginToolContext[],
): { pageContext: string; contextId: string } | null {
  for (const ctx of contexts) {
    if (!ctx.urlPattern) continue;
    const paramNames: string[] = [];
    const regexStr = ctx.urlPattern.replace(/:([^/]+)/g, (_m, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const match = pathname.match(new RegExp(`${regexStr}(?:/|$)`));
    if (match) {
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
      return {
        pageContext: ctx.id,
        contextId: ctx.contextIdParam ? (params[ctx.contextIdParam] || '') : '',
      };
    }
  }
  return null;
}

export function getPageContext(
  pathname: string,
  pluginContexts: PluginToolContext[] = [],
): { pageContext: string; contextId: string } {
  if (pathname.includes('/session/')) {
    const match = pathname.match(/\/session\/(\d+)/);
    return { pageContext: 'session-timeline', contextId: match?.[1] || '' };
  }
  if (pathname.includes('/automations/') && pathname.includes('/edit')) {
    const match = pathname.match(/\/automations\/(\d+)/);
    return { pageContext: 'automations', contextId: match?.[1] || '' };
  }
  if (pathname.includes('/automations')) return { pageContext: 'automations', contextId: '' };
  if (pathname.includes('/traffic')) return { pageContext: 'traffic', contextId: '' };
  if (pathname.includes('/devices')) return { pageContext: 'devices', contextId: '' };
  if (pathname.includes('/credentials')) return { pageContext: 'credentials', contextId: '' };
  if (pathname.includes('/proxies')) return { pageContext: 'proxies', contextId: '' };
  if (pathname.includes('/analysis/')) {
    const match = pathname.match(/\/analysis\/(\d+)/);
    return { pageContext: 'apk-analysis', contextId: match?.[1] || '' };
  }
  if (pathname.includes('/apks')) return { pageContext: 'apk-analysis', contextId: '' };
  if (pathname.includes('/frida')) return { pageContext: 'frida', contextId: '' };
  if (pathname.includes('/api-catalogue')) return { pageContext: 'api-catalogue', contextId: '' };

  // Plugin contexts (dynamic)
  const pluginMatch = matchPluginContext(pathname, pluginContexts);
  if (pluginMatch) return pluginMatch;

  return { pageContext: 'dashboard', contextId: '' };
}
