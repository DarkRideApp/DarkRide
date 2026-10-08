import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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

const restOk = (body: any) => Promise.resolve({ type: 'restapi', id: 'x', status: 200, body });

function wsWith(handler: (method: string, path: string, base: (m: string, p: string) => Promise<any>) => Promise<any> | undefined) {
  const base = makeWs();
  const original = (base.sendRestApi as any).getMockImplementation();
  base.sendRestApi = vi.fn((m: string, p: string, b?: any) => handler(m, p, original) ?? original(m, p, b)) as any;
  return base;
}

async function openAddProvider(ws?: WebSocketContextValue) {
  const r = renderAISection(ws);
  await waitFor(() => expect(screen.getByTestId('add-ai-provider-btn')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('add-ai-provider-btn'));
  return r;
}
const pickType = (t: string) => fireEvent.change(screen.getByTestId('provider-type-select'), { target: { value: t } });

describe('AISection — provider form is driven by the catalog', () => {
  it('lists every catalog type', async () => {
    await openAddProvider();
    const values = Array.from((screen.getByTestId('provider-type-select') as HTMLSelectElement).options).map((o) => o.value);
    for (const id of ['anthropic', 'gemini', 'ollama', 'openrouter', 'codestral', 'mistral', 'openai', 'openai-compatible', 'claude-cli']) {
      expect(values).toContain(id);
    }
  });

  it('shows the key for anthropic, hides it for ollama, and keeps Base URL for both', async () => {
    await openAddProvider();
    pickType('anthropic');
    expect(screen.getByTestId('provider-api-key-input')).toBeInTheDocument();
    expect(screen.getByTestId('provider-base-url-input')).toBeInTheDocument();
    pickType('ollama');
    expect(screen.queryByTestId('provider-api-key-input')).toBeNull();
    expect(screen.getByTestId('provider-base-url-input')).toBeInTheDocument();
  });

  it('claude-cli keeps its oauth token field and hides Base URL', async () => {
    await openAddProvider();
    pickType('claude-cli');
    expect(screen.getByTestId('provider-oauth-token-input')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-base-url-input')).toBeNull();
  });

  it('openai-compatible needs a name and a valid Base URL before Save is enabled', async () => {
    await openAddProvider();
    fireEvent.change(screen.getByTestId('provider-name-input'), { target: { value: 'Local' } });
    pickType('openai-compatible');
    expect(screen.getByTestId('save-provider-btn')).toBeDisabled();            // name set, Base URL missing
    fireEvent.change(screen.getByTestId('provider-base-url-input'), { target: { value: 'localhost:1234' } });
    expect(screen.getByTestId('save-provider-btn')).toBeDisabled();            // malformed
    fireEvent.change(screen.getByTestId('provider-base-url-input'), { target: { value: 'http://127.0.0.1:1234' } });
    expect(screen.getByTestId('save-provider-btn')).not.toBeDisabled();
  });

  it('changing the type clears the Base URL field', async () => {
    await openAddProvider();
    pickType('ollama');
    fireEvent.change(screen.getByTestId('provider-base-url-input'), { target: { value: 'http://host:11434' } });
    pickType('openrouter');
    expect((screen.getByTestId('provider-base-url-input') as HTMLInputElement).value).toBe('');
  });

  it('warns that editing the Base URL of a saved provider clears the key', async () => {
    renderAISection();
    const row = await screen.findByTestId('ai-provider-row-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    expect(screen.queryByText(/clears the saved key/i)).toBeNull();
    fireEvent.change(screen.getByTestId('provider-base-url-input'), { target: { value: 'https://proxy.test' } });
    expect(screen.getByText(/clears the saved key/i)).toBeInTheDocument();
  });

  it('keeps the modal open when the server rejects the save', async () => {
    const ws = wsWith((m, p) => (m === 'POST' && p === '/v1/ai/providers' ? restOk({ success: false, error: 'bad key' }) : undefined));
    await openAddProvider(ws);
    fireEvent.change(screen.getByTestId('provider-name-input'), { target: { value: 'X' } });
    pickType('anthropic');
    fireEvent.click(screen.getByTestId('save-provider-btn'));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/ai/providers', expect.anything()));
    await new Promise((r) => setTimeout(r, 0));                                 // let the post-save handler run, so this fails without the success check
    expect(screen.getByTestId('provider-name-input')).toBeInTheDocument();     // still open
  });

  it('an unchanged legacy Base URL does not block a rename', async () => {
    const ws = wsWith((m, p) => (m === 'GET' && p === '/v1/ai/providers'
      ? restOk({ success: true, data: [{ id: 5, name: 'Old', type: 'ollama', baseUrl: 'localhost:11434', hasApiKey: false, createdAt: 0, updatedAt: 0 }] })
      : undefined));
    renderAISection(ws);
    const row = await screen.findByTestId('ai-provider-row-5');
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByTestId('provider-name-input'), { target: { value: 'Renamed' } });
    expect(screen.getByTestId('save-provider-btn')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('provider-base-url-input'), { target: { value: 'localhost:11435' } });
    expect(screen.getByTestId('save-provider-btn')).toBeDisabled();            // an edited value is validated
  });

  it('keeps the model modal open when the server rejects the save', async () => {
    const ws = wsWith((m, p) => (m === 'POST' && p === '/v1/ai/models' ? restOk({ success: false, error: 'model required' }) : undefined));
    renderAISection(ws);
    await waitFor(() => expect(screen.getByTestId('add-ai-model-btn')).toBeEnabled());
    fireEvent.click(screen.getByTestId('add-ai-model-btn'));
    fireEvent.change(screen.getByTestId('model-name-input'), { target: { value: 'm' } });
    fireEvent.click(screen.getByTestId('save-model-btn'));
    await waitFor(() => expect(ws.sendRestApi).toHaveBeenCalledWith('POST', '/v1/ai/models', expect.anything()));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('model-name-input')).toBeInTheDocument();        // still open
  });

  it('the add-model form requires a model when the provider has no default', async () => {
    const ws = wsWith((m, p) => (m === 'GET' && p === '/v1/ai/providers'
      ? restOk({ success: true, data: [{ id: 3, name: 'Local', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', hasApiKey: false, createdAt: 0, updatedAt: 0 }] })
      : undefined));
    renderAISection(ws);
    await waitFor(() => expect(screen.getByTestId('add-ai-model-btn')).toBeEnabled());    // disabled until the provider list loads
    fireEvent.click(screen.getByTestId('add-ai-model-btn'));
    fireEvent.change(screen.getByTestId('model-name-input'), { target: { value: 'm' } });
    fireEvent.change(screen.getByTestId('model-provider-select'), { target: { value: '3' } });
    expect(screen.getByTestId('save-model-btn')).toBeDisabled();
    expect(screen.queryByText(/optional, uses provider default/i)).toBeNull();
  });
});
