export default function SettingsNavDemo() {
  return (
    <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
      Composite component rendering the host's settings page header + tab strip with hardcoded real routes
      (Settings, Plugins, Marketplace, Proxies, Credentials, Jobs, Utils, MCP Server, Cloud Storage). Each
      tab respects <code>requiredScope</code> filtering and contributes to <code>core:settings:tabs</code> for
      plugins to extend. Not rendered live in the catalog — clicking a tab would navigate away. Visit{' '}
      <code>/ui/settings</code> to see it in context.
    </p>
  );
}
