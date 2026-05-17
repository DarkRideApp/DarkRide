import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AISection } from '../AISection';

function makeWs(overrides?: Partial<WebSocketContextValue>): WebSocketContextValue {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === '/v1/ai/tiers') {
        // Backend `tierStore.list()` shape — array of TierRow.
        return Promise.resolve({
          type: 'restapi', id: 't', status: 200,
          body: [
            { id: 1, name: 'High', sortOrder: 0, isHardcoded: true, enabledModelCount: 3, createdAt: 0, updatedAt: 0 },
            { id: 2, name: 'Low',  sortOrder: 1, isHardcoded: true, enabledModelCount: 1, createdAt: 0, updatedAt: 0 },
          ],
        });
      }
      if (method === 'GET' && path === '/v1/ai/models') {
        return Promise.resolve({
          type: 'restapi', id: 'm', status: 200,
          body: { success: true, data: [
            { id: 10, name: 'gemini-pro', provider: 'gemini', providerId: 1, providerName: 'Gemini', model: 'gemini-1.5-pro', enabled: true, priority: 0, cooldownMinutes: 10, tierId: 1, tierName: 'High', createdAt: 0, updatedAt: 0 },
            { id: 11, name: 'haiku',      provider: 'anthropic', providerId: 2, providerName: 'Anthropic', model: 'claude-haiku-3.5', enabled: true, priority: 1, cooldownMinutes: 10, tierId: 2, tierName: 'Low', createdAt: 0, updatedAt: 0 },
          ] },
        });
      }
      if (method === 'GET' && path === '/v1/ai/providers') {
        return Promise.resolve({
          type: 'restapi', id: 'p', status: 200,
          body: { success: true, data: [
            { id: 1, name: 'Gemini', type: 'gemini', baseUrl: null, hasApiKey: true, createdAt: 0, updatedAt: 0 },
          ] },
        });
      }
      return Promise.resolve({ type: 'restapi', id: 'x', status: 200, body: { success: true } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
    setOnApiError: vi.fn(),
    ...overrides,
  } as any;
}

function renderAISection(ws?: WebSocketContextValue) {
  const mockWs = ws ?? makeWs();
  return {
    ws: mockWs,
    ...render(
      <WebSocketContext.Provider value={mockWs}>
        <ToastProvider>
          <MemoryRouter>
            <AISection />
          </MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>,
    ),
  };
}

describe('AISection — tier + model rendering', () => {
  it('renders tier cards from /v1/ai/tiers', async () => {
    renderAISection();
    // Locate tier cards by data-testid; the tier name itself appears in
    // multiple places (header strong, model row, modal options) so a plain
    // getByText would either ambiguity-throw or miss the intent.
    await waitFor(() => {
      expect(screen.getByTestId('ai-tier-card-1')).toBeInTheDocument();
      expect(screen.getByTestId('ai-tier-card-2')).toBeInTheDocument();
    });
  });

  it('renders models inside their tier cards (5-model regression fixture)', async () => {
    renderAISection();
    await waitFor(() => {
      expect(screen.getByText('gemini-pro')).toBeInTheDocument();
      expect(screen.getByText('haiku')).toBeInTheDocument();
    });
  });

  it('shows model count header', async () => {
    renderAISection();
    await waitFor(() => {
      expect(screen.getByText('2 models configured')).toBeInTheDocument();
    });
  });
});
