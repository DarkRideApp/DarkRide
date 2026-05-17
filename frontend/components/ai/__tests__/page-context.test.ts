import { describe, it, expect } from 'vitest';
import { matchPluginContext, getPageContext, type PluginToolContext } from '../page-context';

// ---------------------------------------------------------------------------
// matchPluginContext
// ---------------------------------------------------------------------------

describe('matchPluginContext', () => {
  it('returns null when no contexts are provided', () => {
    expect(matchPluginContext('/ui/demo-plugin/5', [])).toBeNull();
  });

  it('returns null when pathname does not match any pattern', () => {
    const contexts: PluginToolContext[] = [
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    expect(matchPluginContext('/ui/maps/99', contexts)).toBeNull();
  });

  it('matches a simple pattern and extracts contextId', () => {
    const contexts: PluginToolContext[] = [
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    expect(matchPluginContext('/ui/demo-plugin/5', contexts)).toEqual({
      pageContext: 'demo-plugin',
      contextId: '5',
    });
  });

  it('matches a nested pattern and extracts the contextIdParam correctly', () => {
    const contexts: PluginToolContext[] = [
      { id: 'demo-plugin-diff', urlPattern: '/ui/demo-plugin/:id/diffs/:diffId', contextIdParam: 'diffId' },
    ];
    expect(matchPluginContext('/ui/demo-plugin/5/diffs/12', contexts)).toEqual({
      pageContext: 'demo-plugin-diff',
      contextId: '12',
    });
  });

  it('more specific (longer/first) patterns match when ordered correctly', () => {
    // More specific pattern listed first should win
    const contexts: PluginToolContext[] = [
      { id: 'demo-plugin-diff', urlPattern: '/ui/demo-plugin/:id/diffs/:diffId', contextIdParam: 'diffId' },
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    expect(matchPluginContext('/ui/demo-plugin/5/diffs/12', contexts)).toEqual({
      pageContext: 'demo-plugin-diff',
      contextId: '12',
    });
  });

  it('less specific pattern still matches when the specific one is listed second', () => {
    // When generic pattern is listed first, it wins (order matters)
    const contexts: PluginToolContext[] = [
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
      { id: 'demo-plugin-diff', urlPattern: '/ui/demo-plugin/:id/diffs/:diffId', contextIdParam: 'diffId' },
    ];
    // /ui/demo-plugin/:id pattern matches the beginning of the diff URL too
    const result = matchPluginContext('/ui/demo-plugin/5/diffs/12', contexts);
    expect(result?.pageContext).toBe('demo-plugin');
  });

  it('handles trailing slashes in the pathname', () => {
    const contexts: PluginToolContext[] = [
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    expect(matchPluginContext('/ui/demo-plugin/5/', contexts)).toEqual({
      pageContext: 'demo-plugin',
      contextId: '5',
    });
  });

  it('matches a pathname that has extra segments after the pattern', () => {
    const contexts: PluginToolContext[] = [
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    // Extra segments are allowed by the (?:/|$) trailing anchor
    const result = matchPluginContext('/ui/demo-plugin/5/something/extra', contexts);
    expect(result?.pageContext).toBe('demo-plugin');
    expect(result?.contextId).toBe('5');
  });

  it('returns empty contextId when contextIdParam is not specified', () => {
    const contexts: PluginToolContext[] = [
      { id: 'maps', urlPattern: '/ui/maps/:id' },
    ];
    expect(matchPluginContext('/ui/maps/42', contexts)).toEqual({
      pageContext: 'maps',
      contextId: '',
    });
  });

  it('skips contexts without a urlPattern', () => {
    const contexts: PluginToolContext[] = [
      { id: 'no-pattern' },
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    expect(matchPluginContext('/ui/demo-plugin/7', contexts)).toEqual({
      pageContext: 'demo-plugin',
      contextId: '7',
    });
  });
});

// ---------------------------------------------------------------------------
// getPageContext
// ---------------------------------------------------------------------------

describe('getPageContext', () => {
  // Core contexts ----------------------------------------------------------

  it('maps /ui/session/123 → session-timeline with contextId "123"', () => {
    expect(getPageContext('/ui/session/123')).toEqual({
      pageContext: 'session-timeline',
      contextId: '123',
    });
  });

  it('maps /ui/traffic → traffic', () => {
    expect(getPageContext('/ui/traffic')).toEqual({
      pageContext: 'traffic',
      contextId: '',
    });
  });

  it('maps /ui/automations → automations', () => {
    expect(getPageContext('/ui/automations')).toEqual({
      pageContext: 'automations',
      contextId: '',
    });
  });

  it('maps /ui/automations/7/edit → automations with contextId "7"', () => {
    expect(getPageContext('/ui/automations/7/edit')).toEqual({
      pageContext: 'automations',
      contextId: '7',
    });
  });

  it('maps /ui/frida → frida', () => {
    expect(getPageContext('/ui/frida')).toEqual({
      pageContext: 'frida',
      contextId: '',
    });
  });

  it('maps /ui/devices → devices', () => {
    expect(getPageContext('/ui/devices')).toEqual({
      pageContext: 'devices',
      contextId: '',
    });
  });

  it('maps /ui/proxies → proxies', () => {
    expect(getPageContext('/ui/proxies')).toEqual({
      pageContext: 'proxies',
      contextId: '',
    });
  });

  it('maps /ui/credentials → credentials', () => {
    expect(getPageContext('/ui/credentials')).toEqual({
      pageContext: 'credentials',
      contextId: '',
    });
  });

  it('maps /ui/apks → apk-analysis', () => {
    expect(getPageContext('/ui/apks')).toEqual({
      pageContext: 'apk-analysis',
      contextId: '',
    });
  });

  it('maps /ui/analysis/42 → apk-analysis with contextId "42"', () => {
    expect(getPageContext('/ui/analysis/42')).toEqual({
      pageContext: 'apk-analysis',
      contextId: '42',
    });
  });

  // Plugin contexts --------------------------------------------------------

  it('maps /ui/demo-plugin/5 → demo-plugin with contextId "5" (plugin context)', () => {
    const pluginContexts: PluginToolContext[] = [
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    expect(getPageContext('/ui/demo-plugin/5', pluginContexts)).toEqual({
      pageContext: 'demo-plugin',
      contextId: '5',
    });
  });

  it('maps /ui/demo-plugin/5/diffs/12 → demo-plugin-diff with contextId "12" (more specific match first)', () => {
    const pluginContexts: PluginToolContext[] = [
      { id: 'demo-plugin-diff', urlPattern: '/ui/demo-plugin/:id/diffs/:diffId', contextIdParam: 'diffId' },
      { id: 'demo-plugin', urlPattern: '/ui/demo-plugin/:id', contextIdParam: 'id' },
    ];
    expect(getPageContext('/ui/demo-plugin/5/diffs/12', pluginContexts)).toEqual({
      pageContext: 'demo-plugin-diff',
      contextId: '12',
    });
  });

  it('maps /ui/maps/42 → maps with contextId "42" (plugin context)', () => {
    const pluginContexts: PluginToolContext[] = [
      { id: 'maps', urlPattern: '/ui/maps/:id', contextIdParam: 'id' },
    ];
    expect(getPageContext('/ui/maps/42', pluginContexts)).toEqual({
      pageContext: 'maps',
      contextId: '42',
    });
  });

  it('returns dashboard when no path matches', () => {
    expect(getPageContext('/ui/unknown-page')).toEqual({
      pageContext: 'dashboard',
      contextId: '',
    });
  });

  it('returns dashboard for root path with empty pluginContexts', () => {
    expect(getPageContext('/', [])).toEqual({
      pageContext: 'dashboard',
      contextId: '',
    });
  });

  it('core contexts take precedence over plugin contexts — /ui/devices is always "devices"', () => {
    const pluginContexts: PluginToolContext[] = [
      { id: 'evil-devices-override', urlPattern: '/ui/devices/:id', contextIdParam: 'id' },
    ];
    expect(getPageContext('/ui/devices', pluginContexts)).toEqual({
      pageContext: 'devices',
      contextId: '',
    });
  });

  it('empty pluginContexts array falls through to dashboard for unknown paths', () => {
    expect(getPageContext('/ui/some-plugin-page', [])).toEqual({
      pageContext: 'dashboard',
      contextId: '',
    });
  });

  it('pluginContexts defaults to empty array (no second argument)', () => {
    expect(getPageContext('/ui/nowhere')).toEqual({
      pageContext: 'dashboard',
      contextId: '',
    });
  });
});
