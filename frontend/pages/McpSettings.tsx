import React, { useState, useEffect, useCallback } from 'react';
import { useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import { useAuthOptional } from '@darkrideapp/plugin-sdk/react';
import { AccessDenied } from '../components/auth/AccessDenied';

export function McpSettings() {
  useDocumentTitle('MCP Server');
  const ws = useWebSocket();
  const auth = useAuthOptional();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [publicBaseUrl, setPublicBaseUrl] = useState<string>('');
  const [publicBaseUrlDirty, setPublicBaseUrlDirty] = useState(false);
  const [isSavingUrl, setIsSavingUrl] = useState(false);

  const effectiveBaseUrl = publicBaseUrl || window.location.origin;
  const mcpUrl = `${effectiveBaseUrl.replace(/\/$/, '')}/mcp`;

  // Fetch MCP enabled state
  useEffect(() => {
    ws.sendRestApi('GET', '/v1/settings/mcp_enabled').then((res) => {
      if (res.body?.success) {
        setEnabled(res.body.data.value !== 'false');
      } else {
        // Setting not found = default to true
        setEnabled(true);
      }
    }).catch(() => setEnabled(true));
  }, [ws]);

  // Fetch oauth_public_base_url
  useEffect(() => {
    ws.sendRestApi('GET', '/v1/settings/oauth_public_base_url').then((res) => {
      if (res.body?.success) {
        setPublicBaseUrl(res.body.data.value || '');
      }
    }).catch(() => {});
  }, [ws]);

  // Fetch tool count
  useEffect(() => {
    ws.sendRestApi('GET', '/v1/plugins/registry').then((res) => {
      if (res.body?.success && res.body.data?.tools) {
        setToolCount(res.body.data.tools.length);
      }
    }).catch(() => {});
  }, [ws]);

  const handleToggle = useCallback(() => {
    const newValue = enabled ? 'false' : 'true';
    ws.sendRestApi('PUT', '/v1/settings/mcp_enabled', { value: newValue }).then(() => {
      setEnabled(newValue !== 'false');
    });
  }, [ws, enabled]);

  const handleSavePublicBaseUrl = useCallback(() => {
    setIsSavingUrl(true);
    ws.sendRestApi('PUT', '/v1/settings/oauth_public_base_url', { value: publicBaseUrl }).then(() => {
      setPublicBaseUrlDirty(false);
    }).finally(() => {
      setIsSavingUrl(false);
    });
  }, [ws, publicBaseUrl]);

  const copyToClipboard = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  }, []);

  if (auth && !auth.hasScope('core.settings:write')) return <AccessDenied scope="core.settings:write" />;

  const claudeCodeCmd = `claude mcp add darkride ${mcpUrl.replace(/\/$/, '')} --transport http`;
  const claudeDesktopConfig = JSON.stringify({
    mcpServers: {
      darkride: {
        type: 'http',
        url: mcpUrl,
      },
    },
  }, null, 2);

  return (
    <div data-testid="mcp-settings-page">
      <header className="settings-page-header">
        <h1>MCP Server</h1>
      </header>

      <div className="mcp-settings">
        {/* Enable/Disable toggle */}
        <div className="mcp-toggle-card">
          <div className="mcp-toggle-info">
            <h3>MCP Server</h3>
            <p>Allow external AI agents to access DarkRide tools</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {enabled !== null && (
              <span className={`mcp-status ${enabled ? 'mcp-status-active' : 'mcp-status-disabled'}`}>
                {enabled ? 'Active' : 'Disabled'}
              </span>
            )}
            <button
              data-testid="mcp-toggle"
              className={`toggle-switch ${enabled ? 'toggle-on' : ''}`}
              onClick={handleToggle}
              disabled={enabled === null}
              aria-label={enabled ? 'Disable MCP server' : 'Enable MCP server'}
              style={{
                width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                background: enabled ? 'var(--accent)' : 'var(--border-color)',
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 2, left: enabled ? 22 : 2,
                width: 20, height: 20, borderRadius: 10,
                background: '#fff', transition: 'left 0.2s',
              }} />
            </button>
          </div>
        </div>

        {/* Public Base URL setting */}
        <div className="mcp-settings-card" style={{ marginBottom: 24 }}>
          <label style={{ display: 'block' }}>
            <div style={{ fontWeight: 500, marginBottom: 4, fontSize: 14 }}>Public Base URL</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                data-testid="public-base-url-input"
                type="url"
                value={publicBaseUrl}
                onChange={(e) => {
                  setPublicBaseUrl(e.target.value);
                  setPublicBaseUrlDirty(true);
                }}
                placeholder="https://darkride.example.com"
                style={{
                  flex: 1, padding: 8,
                  border: '1px solid var(--border-color)',
                  borderRadius: 4, background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  fontFamily: 'inherit',
                }}
              />
              {publicBaseUrlDirty && (
                <button
                  data-testid="public-base-url-save"
                  onClick={handleSavePublicBaseUrl}
                  disabled={isSavingUrl}
                  style={{
                    padding: '8px 12px',
                    background: 'var(--accent)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    cursor: isSavingUrl ? 'default' : 'pointer',
                    opacity: isSavingUrl ? 0.6 : 1,
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  {isSavingUrl ? 'Saving...' : 'Save'}
                </button>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
              How this server is reached from outside — used as the OAuth issuer URL
              (advertised at <code>/.well-known/oauth-authorization-server</code> for MCP client auto-discovery)
              and as the base for deep links in push notifications. Falls back to the request host if left blank.
            </p>
          </label>
        </div>

        {/* Connection details — only shown when enabled */}
        {enabled && (
          <div className="mcp-connection-details" data-testid="mcp-connection-details">
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Connection Details</h3>

            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <strong>MCP Server URL</strong>
            </div>
            <div className="mcp-url-row">
              <code data-testid="mcp-url">{mcpUrl}</code>
              <button
                className="btn btn-sm mcp-copy-btn"
                data-testid="mcp-url-copy"
                onClick={() => copyToClipboard(mcpUrl, 'url')}
              >
                {copied === 'url' ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 24, fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
              <span><strong>Protocol:</strong> HTTP Streamable</span>
              {toolCount !== null && <span>{toolCount} tools available</span>}
            </div>

            {/* Setup guides */}
            <h3 style={{ fontSize: 15, marginBottom: 12 }}>Setup Guide</h3>

            <div className="mcp-guide-section">
              <h4>Claude Code</h4>
              <pre>
                <code>{claudeCodeCmd}</code>
                <button
                  className="btn btn-sm mcp-copy-btn"
                  onClick={() => copyToClipboard(claudeCodeCmd, 'claude-code')}
                >
                  {copied === 'claude-code' ? 'Copied!' : 'Copy'}
                </button>
              </pre>
            </div>

            <div className="mcp-guide-section">
              <h4>Claude Desktop</h4>
              <pre>
                <code>{claudeDesktopConfig}</code>
                <button
                  className="btn btn-sm mcp-copy-btn"
                  onClick={() => copyToClipboard(claudeDesktopConfig, 'claude-desktop')}
                >
                  {copied === 'claude-desktop' ? 'Copied!' : 'Copy'}
                </button>
              </pre>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                Config file location: macOS <code>~/Library/Application Support/Claude/claude_desktop_config.json</code>,
                Windows <code>%APPDATA%\Claude\claude_desktop_config.json</code>
              </p>
            </div>

            {/* Authentication */}
            <div className="mcp-guide-section">
              <h4>Authentication</h4>
              <div className="mcp-note">
                When auth is enabled, MCP requests require an API key. Include a Bearer token in the
                Authorization header: <code>Authorization: Bearer YOUR_API_KEY</code>
              </div>
              <p style={{ fontSize: 13, marginTop: 8 }}>
                <a href="/ui/profile" style={{ color: 'var(--accent)' }}>Create API keys in your profile</a>
              </p>
            </div>

            {/* Security note */}
            <div className="mcp-note">
              MCP tool access is scope-gated — the API key's scopes determine which tools are available.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
