import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { McpSettings } from './McpSettings';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';
import { ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';

function createMockWs(overrides?: Partial<Record<string, any>>): WebSocketContextValue {
  const sendRestApi = vi.fn().mockImplementation((method: string, path: string, body?: any) => {
    if (path === '/v1/settings/mcp_enabled') {
      if (method === 'GET') {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { key: 'mcp_enabled', value: overrides?.mcpEnabled ?? 'true' } },
        });
      }
      if (method === 'PUT') {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: { success: true, data: { key: 'mcp_enabled', value: body?.value } },
        });
      }
    }
    if (path === '/v1/settings/oauth_public_base_url') {
      if (method === 'GET') {
        return Promise.resolve({
          type: 'restapi', id: '3', status: 200,
          body: { success: true, data: { key: 'oauth_public_base_url', value: overrides?.publicBaseUrl ?? '' } },
        });
      }
      if (method === 'PUT') {
        return Promise.resolve({
          type: 'restapi', id: '3', status: 200,
          body: { success: true, data: { key: 'oauth_public_base_url', value: body?.value } },
        });
      }
    }
    if (path === '/v1/plugins/registry') {
      return Promise.resolve({
        type: 'restapi', id: '2', status: 200,
        body: { success: true, data: { tools: overrides?.tools ?? Array(12).fill({ name: 'tool' }) } },
      });
    }
    return Promise.resolve({ type: 'restapi', id: '0', status: 200, body: {} });
  });

  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function renderMcpSettings(wsOverrides?: Partial<Record<string, any>>) {
  const ws = createMockWs(wsOverrides);
  render(
    <WebSocketContext.Provider value={ws}>
      <ToastProvider>
        <MemoryRouter>
          <McpSettings />
        </MemoryRouter>
      </ToastProvider>
    </WebSocketContext.Provider>,
  );
  return ws;
}

describe('McpSettings', () => {
  beforeEach(() => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('renders toggle in enabled state', async () => {
    renderMcpSettings({ mcpEnabled: 'true' });
    await waitFor(() => {
      expect(screen.getByTestId('mcp-settings-page')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
    });
  });

  it('renders toggle in disabled state', async () => {
    renderMcpSettings({ mcpEnabled: 'false' });
    await waitFor(() => {
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });
  });

  it('toggle calls PUT settings API', async () => {
    const ws = renderMcpSettings({ mcpEnabled: 'true' });
    await waitFor(() => screen.getByTestId('mcp-toggle'));

    fireEvent.click(screen.getByTestId('mcp-toggle'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('PUT', '/v1/settings/mcp_enabled', { value: 'false' });
    });
  });

  it('shows MCP URL with current origin', async () => {
    renderMcpSettings({ mcpEnabled: 'true' });
    await waitFor(() => {
      const urlElement = screen.getByTestId('mcp-url');
      expect(urlElement.textContent).toContain('/mcp');
    });
  });

  it('copy button copies URL to clipboard', async () => {
    renderMcpSettings({ mcpEnabled: 'true' });
    await waitFor(() => screen.getByTestId('mcp-url-copy'));

    fireEvent.click(screen.getByTestId('mcp-url-copy'));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('/mcp'),
      );
    });
  });

  it('shows setup guide sections', async () => {
    renderMcpSettings({ mcpEnabled: 'true' });
    await waitFor(() => {
      expect(screen.getByText('Claude Code')).toBeInTheDocument();
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
    });
  });

  it('shows tool count from registry', async () => {
    renderMcpSettings({ mcpEnabled: 'true', tools: Array(15).fill({ name: 'tool' }) });
    await waitFor(() => {
      expect(screen.getByText(/15 tools available/)).toBeInTheDocument();
    });
  });

  it('hides connection details when disabled', async () => {
    renderMcpSettings({ mcpEnabled: 'false' });
    await waitFor(() => screen.getByText('Disabled'));
    expect(screen.queryByTestId('mcp-connection-details')).not.toBeInTheDocument();
  });

  it('loads oauth_public_base_url setting on mount', async () => {
    const ws = renderMcpSettings({ publicBaseUrl: 'https://example.com' });
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('GET', '/v1/settings/oauth_public_base_url');
    });
  });

  it('displays public base url input field', async () => {
    renderMcpSettings({ mcpEnabled: 'true', publicBaseUrl: '' });
    await waitFor(() => {
      const input = screen.getByTestId('public-base-url-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.placeholder).toBe('https://darkride.example.com');
    });
  });

  it('shows save button when public base url is dirty', async () => {
    renderMcpSettings({ mcpEnabled: 'true' });
    await waitFor(() => screen.getByTestId('public-base-url-input'));

    const input = screen.getByTestId('public-base-url-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });

    await waitFor(() => {
      expect(screen.getByTestId('public-base-url-save')).toBeInTheDocument();
    });
  });

  it('saves public base url via PUT settings API', async () => {
    const ws = renderMcpSettings({ mcpEnabled: 'true' });
    await waitFor(() => screen.getByTestId('public-base-url-input'));

    const input = screen.getByTestId('public-base-url-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://example.com' } });

    await waitFor(() => screen.getByTestId('public-base-url-save'));
    fireEvent.click(screen.getByTestId('public-base-url-save'));

    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith('PUT', '/v1/settings/oauth_public_base_url', { value: 'https://example.com' });
    });
  });

  it('uses public base url in MCP URL when set', async () => {
    renderMcpSettings({ mcpEnabled: 'true', publicBaseUrl: 'https://example.com' });
    await waitFor(() => {
      const urlElement = screen.getByTestId('mcp-url');
      expect(urlElement.textContent).toBe('https://example.com/mcp');
    });
  });

  it('falls back to window.location.origin when public base url is empty', async () => {
    renderMcpSettings({ mcpEnabled: 'true', publicBaseUrl: '' });
    await waitFor(() => {
      const urlElement = screen.getByTestId('mcp-url');
      expect(urlElement.textContent).toContain('/mcp');
      expect(urlElement.textContent).not.toBe('/mcp');
    });
  });
});
