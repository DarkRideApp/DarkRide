import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { WebSocketContext, type WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AiChatDrawer } from './AiChatDrawer';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('rehype-highlight', () => ({ default: () => {} }));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

async function renderDrawer(initialPath: string, sendRestApi: WebSocketContextValue['sendRestApi']) {
  const sendMessage = vi.fn();
  const ws: WebSocketContextValue = {
    connected: true,
    serverReady: true,
    startupMessage: 'Ready',
    sendMessage,
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeBinary: vi.fn().mockReturnValue(() => {}),
  };
  // Let the drawer's plugin registry fetch settle inside act.
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[initialPath]}>
        <WebSocketContext.Provider value={ws}>
          <AiChatDrawer />
          <LocationProbe />
        </WebSocketContext.Provider>
      </MemoryRouter>,
    );
  });
  return { sendMessage };
}

describe('AiChatDrawer', () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: true, data: [] }) }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tells a new chat where in the app it was started, query string included', async () => {
    const sendRestApi = vi.fn().mockResolvedValue({ id: '1', type: 'restapi', status: 200, body: { data: null } });
    const { sendMessage } = await renderDrawer('/ui/devices?filter=online', sendRestApi as unknown as WebSocketContextValue['sendRestApi']);

    fireEvent.click(screen.getByTestId('ai-chat-fab'));
    fireEvent.change(screen.getByTestId('ai-chat-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('ai-chat-send-btn'));

    expect(sendMessage).toHaveBeenCalledWith('ai:message', expect.objectContaining({
      pageContext: 'devices',
      originPath: '/ui/devices?filter=online',
    }));
  });

  it('takes you to the page a chat started on, and keeps the drawer open', async () => {
    const restored = {
      id: 7,
      pageContext: 'automations',
      contextId: '',
      title: 'Why did it fail',
      originPath: '/ui/automations?tab=runs',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      unfinished: false,
      messages: [{ role: 'user', content: 'Why did it fail' }],
    };
    const sendRestApi = vi.fn((_method: string, url: string) => Promise.resolve({
      id: '1',
      type: 'restapi',
      status: 200,
      body: { data: url === '/v1/ai/conversations/7' ? restored : null },
    }));
    localStorage.setItem('darkride:ai-chat:open:devices:', '7');
    await renderDrawer('/ui/devices', sendRestApi as unknown as WebSocketContextValue['sendRestApi']);

    fireEvent.click(screen.getByTestId('ai-chat-fab'));
    expect(await screen.findByTestId('ai-chat-origin-bar')).toHaveTextContent('Started on Automations');
    expect(screen.getByTestId('location')).toHaveTextContent('/ui/devices');

    fireEvent.click(screen.getByTestId('ai-chat-origin-go'));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/ui/automations?tab=runs'));
    expect(screen.getByTestId('ai-chat-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-chat-origin-bar')).not.toBeInTheDocument();
  });
});
